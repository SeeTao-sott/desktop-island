//! 手机遥控走蓝牙：电脑开一个经典蓝牙（RFCOMM）服务，手机上的「桌面遥控」App 连过来。
//! 请求、回应和 https 网页那套完全一样（都交给 Phone::route），只是换了一条线传。
//!
//! 安全：只接受已经和这台电脑配对过的手机（系统层面的蓝牙认证），所以蓝牙这条线不用密钥。
//!
//! 线上的格式（两个方向一样）：一帧 = [头长度 u32 小端][头 JSON][内容长度 u32 小端][内容]
//! - 请求头 {"id":1,"m":"POST","u":"/api/mouse"}；内容太大时拆成几帧，前面的帧带 "more":true
//! - 回应头 {"id":1,"s":200,"t":"application/json; charset=utf-8"}
//! 一般请求单独开线程处理（传文件、读歌单时不挡别的）。
//! 鼠标、手柄、按键、音游点击这类又小又频繁的，在读线程上按到达顺序马上做（不会乱序）；
//! 请求头带 "nr":true 的不回应 —— 手机只管一直发，不用等回应再发下一个，和蓝牙鼠标一样顺。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use windows::core::{GUID, PWSTR};
use windows::Win32::Devices::Bluetooth::{AF_BTH, BTHPROTO_RFCOMM, NS_BTH, SOCKADDR_BTH, SOL_RFCOMM, SO_BTH_AUTHENTICATE};
use windows::Win32::Networking::WinSock::{
    accept, bind, closesocket, getsockname, listen, recv, send, setsockopt, socket, WSASetServiceW, WSAStartup, CSADDR_INFO,
    RNRSERVICE_DELETE, RNRSERVICE_REGISTER, SEND_RECV_FLAGS, SOCKADDR, SOCKET, SOCKET_ADDRESS, SOCK_STREAM, WSADATA, WSAQUERYSETW,
};

use crate::phone::Resp;

/// 服务的编号，手机 App 按这个找到电脑上的服务（两边写死同一个）
pub const SERVICE_UUID: GUID = GUID::from_u128(0x7d2e9b14_5c3a_4f61_a8e0_3b9c6d1f2a47);
/// 一个请求的内容最多 1GB（和 https 传文件一样）
const MAX_BODY: usize = 1 << 30;
const MAX_HEAD: usize = 64 * 1024;
/// 固定用的 RFCOMM 通道（1~30 里不常被占的一个）
const FIXED_CHANNEL: u32 = 21;

/// 处理请求的那一方（就是 Phone；测试时换成假的）
pub trait Route: Send + Sync + 'static {
    fn route(&self, method: &str, url: &str, body: &mut dyn Read, body_len: Option<u64>) -> Resp;
}

// ---------------- 帧 ----------------

fn read_u32(r: &mut impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(Value, Vec<u8>)> {
    let hl = read_u32(r)? as usize;
    if hl > MAX_HEAD {
        return Err(std::io::Error::other("帧头太长"));
    }
    let mut head = vec![0u8; hl];
    r.read_exact(&mut head)?;
    let bl = read_u32(r)? as usize;
    if bl > MAX_BODY {
        return Err(std::io::Error::other("内容太长"));
    }
    let mut body = vec![0u8; bl];
    r.read_exact(&mut body)?;
    let head = serde_json::from_slice(&head).map_err(std::io::Error::other)?;
    Ok((head, body))
}

pub fn write_frame(w: &mut impl Write, head: &Value, body: &[u8]) -> std::io::Result<()> {
    let h = head.to_string().into_bytes();
    // 拼成一块再写：蓝牙上一次写一小段很浪费
    let mut buf = Vec::with_capacity(8 + h.len() + body.len());
    buf.extend_from_slice(&(h.len() as u32).to_le_bytes());
    buf.extend_from_slice(&h);
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(body);
    w.write_all(&buf)?;
    w.flush()
}

/// 一条连接：一直读请求，每个请求开线程处理，回应写回同一条线（写的时候加锁）
pub fn serve<R: Read, W: Write + Send + 'static>(router: Arc<dyn Route>, mut reader: R, writer: W) {
    let writer = Arc::new(Mutex::new(writer));
    // 还没收完内容的请求：编号 → (方法, 路径, 已收到的内容)
    let mut pending: HashMap<u64, (String, String, Vec<u8>)> = HashMap::new();
    loop {
        let (head, body) = match read_frame(&mut reader) {
            Ok(f) => f,
            Err(_) => return, // 断开了
        };
        let id = head.get("id").and_then(Value::as_u64).unwrap_or(0);
        let more = head.get("more").and_then(Value::as_bool).unwrap_or(false);
        let entry = pending.entry(id).or_insert_with(|| {
            let m = head.get("m").and_then(Value::as_str).unwrap_or("").to_string();
            let u = head.get("u").and_then(Value::as_str).unwrap_or("/").to_string();
            (m, u, Vec::new())
        });
        if entry.2.len() + body.len() > MAX_BODY {
            pending.remove(&id);
            let r = Resp { status: 413, ctype: "text/plain; charset=utf-8", body: "太大了".as_bytes().to_vec() };
            let _ = write_frame(&mut *writer.lock().unwrap(), &json!({ "id": id, "s": r.status, "t": r.ctype }), &r.body);
            continue;
        }
        entry.2.extend_from_slice(&body);
        if more {
            continue;
        }
        let (m, u, data) = pending.remove(&id).unwrap();
        let no_reply = head.get("nr").and_then(Value::as_bool).unwrap_or(false);
        let now = inline(&u);
        let run = {
            let router = router.clone();
            let writer = writer.clone();
            move || {
                let len = data.len() as u64;
                let r = router.route(&m, &u, &mut data.as_slice(), Some(len));
                if !no_reply {
                    let _ = write_frame(&mut *writer.lock().unwrap(), &json!({ "id": id, "s": r.status, "t": r.ctype }), &r.body);
                }
            }
        };
        if now {
            run();
        } else {
            thread::spawn(run);
        }
    }
}

/// 又小又要按顺序的请求：在读线程上直接做
fn inline(url: &str) -> bool {
    let path = url.split('?').next().unwrap_or("");
    matches!(path, "/api/mouse" | "/api/pad" | "/api/keys" | "/api/rhythm/hit")
}

// ---------------- 蓝牙套接字 ----------------

struct Sock(SOCKET);

impl Read for Sock {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = unsafe { recv(self.0, buf, SEND_RECV_FLAGS(0)) };
        if n < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
}

impl Write for Sock {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = unsafe { send(self.0, buf, SEND_RECV_FLAGS(0)) };
        if n < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 开着的蓝牙服务；drop 时关掉
pub struct BtServer {
    listen: SOCKET,
    addr: Box<SOCKADDR_BTH>,
    stopped: Arc<AtomicBool>,
    /// 现在连着几台手机
    pub clients: Arc<AtomicUsize>,
    /// 服务坏了（蓝牙被关掉 / 重启过）：Phone 那边看到就重开一个
    pub dead: Arc<AtomicBool>,
}

unsafe impl Send for BtServer {}
unsafe impl Sync for BtServer {}

fn wsa() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let mut d = WSADATA::default();
        let _ = WSAStartup(0x0202, &mut d);
    });
}

/// 在系统里登记 / 撤销"桌面遥控"这个蓝牙服务（手机按编号找到它、知道连哪个通道）
unsafe fn set_service(addr: &mut SOCKADDR_BTH, register: bool) -> i32 {
    let mut name: Vec<u16> = "桌面遥控".encode_utf16().chain(std::iter::once(0)).collect();
    let mut guid = SERVICE_UUID;
    let mut cs: CSADDR_INFO = unsafe { std::mem::zeroed() };
    cs.LocalAddr = SOCKET_ADDRESS { lpSockaddr: addr as *mut SOCKADDR_BTH as *mut SOCKADDR, iSockaddrLength: size_of::<SOCKADDR_BTH>() as i32 };
    cs.iSocketType = SOCK_STREAM.0;
    cs.iProtocol = BTHPROTO_RFCOMM as i32;
    let mut qs: WSAQUERYSETW = unsafe { std::mem::zeroed() };
    qs.dwSize = size_of::<WSAQUERYSETW>() as u32;
    qs.lpszServiceInstanceName = PWSTR(name.as_mut_ptr());
    qs.lpServiceClassId = &mut guid;
    qs.dwNameSpace = NS_BTH;
    qs.dwNumberOfCsAddrs = 1;
    qs.lpcsaBuffer = &mut cs;
    unsafe { WSASetServiceW(&qs, if register { RNRSERVICE_REGISTER } else { RNRSERVICE_DELETE }, 0) }
}

impl BtServer {
    pub fn start(router: Arc<dyn Route>) -> Result<BtServer, String> {
        wsa();
        unsafe {
            let s = socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM as i32).map_err(|e| format!("这台电脑的蓝牙用不了：{e}"))?;
            // 只接受配对过的设备
            let on = 1u32.to_le_bytes();
            if setsockopt(s, SOL_RFCOMM as i32, SO_BTH_AUTHENTICATE as i32, Some(&on)) != 0 {
                eprintln!("蓝牙遥控：设不了「只接受配对设备」：{}", std::io::Error::last_os_error());
            }
            // 先用固定的通道：程序被强制结束时系统里的旧登记删不掉，旧登记指的也是这个通道，手机照样连得上；
            // 被别的程序占了才让系统随便分一个
            let mut addr = Box::new(SOCKADDR_BTH { addressFamily: AF_BTH, btAddr: 0, serviceClassId: GUID::zeroed(), port: FIXED_CHANNEL });
            let len = size_of::<SOCKADDR_BTH>() as i32;
            if bind(s, &*addr as *const SOCKADDR_BTH as *const SOCKADDR, len) != 0 {
                addr.port = u32::MAX;
            }
            if addr.port == u32::MAX && bind(s, &*addr as *const SOCKADDR_BTH as *const SOCKADDR, len) != 0 {
                let e = std::io::Error::last_os_error();
                let _ = closesocket(s);
                return Err(format!("蓝牙开不了（是不是关着？）：{e}"));
            }
            if listen(s, 2) != 0 {
                let e = std::io::Error::last_os_error();
                let _ = closesocket(s);
                return Err(format!("蓝牙听不了：{e}"));
            }
            let mut l = len;
            getsockname(s, &mut *addr as *mut SOCKADDR_BTH as *mut SOCKADDR, &mut l);
            // 刚开机时蓝牙还没准备好，拿不到本机地址：算失败，过一会儿再试
            let local = addr.btAddr;
            if local == 0 {
                let _ = closesocket(s);
                return Err("蓝牙还没准备好".into());
            }
            if set_service(&mut addr, true) != 0 {
                let e = std::io::Error::last_os_error();
                let _ = closesocket(s);
                return Err(format!("蓝牙服务登记不了：{e}"));
            }
            let port = addr.port;
            eprintln!("蓝牙遥控已开启（通道 {port}）");
            let stopped = Arc::new(AtomicBool::new(false));
            let clients = Arc::new(AtomicUsize::new(0));
            let (st, cl) = (stopped.clone(), clients.clone());
            let raw = s.0;
            let dead = Arc::new(AtomicBool::new(false));
            let dd = dead.clone();
            thread::spawn(move || loop {
                let c = match accept(SOCKET(raw), None, None) {
                    Ok(c) => c,
                    Err(e) => {
                        if !st.load(Ordering::SeqCst) {
                            // 不是我们自己关的：蓝牙被关掉或重启了，这个服务已经没用，交给 Phone 重开
                            eprintln!("蓝牙遥控：服务断了（{e}），稍后重开");
                            dd.store(true, Ordering::SeqCst);
                        }
                        return;
                    }
                };
                let router = router.clone();
                let cl = cl.clone();
                thread::spawn(move || {
                    cl.fetch_add(1, Ordering::SeqCst);
                    eprintln!("蓝牙遥控：手机连上了");
                    serve(router, Sock(c), Sock(c));
                    let _ = closesocket(c);
                    cl.fetch_sub(1, Ordering::SeqCst);
                    eprintln!("蓝牙遥控：手机断开了");
                });
            });
            Ok(BtServer { listen: s, addr, stopped, clients, dead })
        }
    }
}

impl Drop for BtServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        unsafe {
            set_service(&mut self.addr, false);
            let _ = closesocket(self.listen);
        }
        eprintln!("蓝牙遥控已关闭");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    struct Echo;
    impl Route for Echo {
        fn route(&self, method: &str, url: &str, body: &mut dyn Read, body_len: Option<u64>) -> Resp {
            let mut b = Vec::new();
            body.read_to_end(&mut b).unwrap();
            let v = json!({ "m": method, "u": url, "len": body_len, "sum": b.iter().map(|&x| x as u64).sum::<u64>() });
            Resp { status: 200, ctype: "application/json", body: v.to_string().into_bytes() }
        }
    }

    /// 用本机 TCP 代替蓝牙，测帧格式、拆包、并发回应
    #[test]
    fn frames_round_trip() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            serve(Arc::new(Echo), s.try_clone().unwrap(), s);
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // 一个小请求
        write_frame(&mut c, &json!({ "id": 1, "m": "GET", "u": "/api/state" }), b"").unwrap();
        // 一个拆成三段的大请求，中间夹一个小请求
        let part = vec![1u8; 50_000];
        write_frame(&mut c, &json!({ "id": 2, "m": "POST", "u": "/api/upload?name=a.jpg", "more": true }), &part).unwrap();
        write_frame(&mut c, &json!({ "id": 3, "m": "POST", "u": "/api/mouse" }), b"[]").unwrap();
        write_frame(&mut c, &json!({ "id": 2, "more": true }), &part).unwrap();
        write_frame(&mut c, &json!({ "id": 2 }), &part).unwrap();
        // 不要回应的：电脑照做，但不回
        write_frame(&mut c, &json!({ "id": 0, "m": "POST", "u": "/api/mouse", "nr": true }), b"[]").unwrap();
        let mut got = HashMap::new();
        for _ in 0..3 {
            let (h, b) = read_frame(&mut c).unwrap();
            got.insert(h["id"].as_u64().unwrap(), serde_json::from_slice::<Value>(&b).unwrap());
        }
        assert_eq!(got[&1]["u"], "/api/state");
        assert_eq!(got[&3]["u"], "/api/mouse");
        assert_eq!(got[&2]["u"], "/api/upload?name=a.jpg");
        assert_eq!(got[&2]["len"], 150_000);
        assert_eq!(got[&2]["sum"], 150_000);
        // 再发一个要回应的：收到的应该是它（编号 4），而不是上面那个不要回应的
        write_frame(&mut c, &json!({ "id": 4, "m": "GET", "u": "/api/time" }), b"").unwrap();
        let (h, _) = read_frame(&mut c).unwrap();
        assert_eq!(h["id"], 4);
    }
}
