//! 手机遥控：在家里的局域网开一个小网页，手机扫码打开就能用（不用装 App）。
//!
//! 能做的：看电脑在放的歌、切歌暂停；番茄钟；回到桌面；看 CPU / 显卡温度 / 电量；
//! 把手机上打的字送到电脑剪贴板；把手机里的照片、文件传进架子的「手机」分类。
//! 手机当触控板控制鼠标（移动、左右键、滚轮、返回 / 前进键），切换电脑上的窗口（见 phone_input.rs）。
//! 手机当手柄玩电脑游戏（虚拟 Xbox 手柄 / 键盘鼠标，见 phone_pad.rs）。
//! 音游手机模式：手机上选歌、点靶子，电脑照常放歌、画裂缝（局面由裂缝页面推上来，见 rift.rs）。
//!
//! 安全：
//! - 默认关着，托盘里打开才开始监听
//! - 每个请求都要带二维码里的随机密钥（32 位十六进制），没带或不对一律拒绝
//! - 只接受局域网 / 本机地址（192.168.x、10.x、172.16–31.x、IPv6 本地），外网来的直接拒绝
//! - 传文件只写进架子的「手机」文件夹，文件名只取最后一段、重名自动改名，绝不覆盖；单个最大 1GB
//! - 不读、不发任何别的东西；只在局域网里，没有上传到外面
//! - 走 https（自己生成的证书，存在配置文件夹）：手机浏览器只在 https 网页里给陀螺仪数据（体感鼠标）。
//!   证书不是机构签发的，手机第一次打开会提示"不安全"，点"高级 → 继续"一次就好

use std::io::Read;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tiny_http::{Header, Method, Request, Response, Server};

const PAGE: &str = include_str!("../phone/index.html");
/// 单个文件最大 1GB
const MAX_UPLOAD: u64 = 1 << 30;
/// 发到剪贴板的文字最长 100KB
const MAX_TEXT: u64 = 100 * 1024;
/// 一批鼠标动作最多 64KB
const MAX_MOUSE: u64 = 64 * 1024;

/// 手机上要显示的最新状态（从程序里本来就有的事件收集来）
#[derive(Default)]
struct Snapshot {
    media: Value,
    cover: String,
    pomo: Value,
    stat: Value,
}

pub struct Phone {
    app: AppHandle,
    token: String,
    port: u16,
    shelf_dir: Option<PathBuf>,
    keep: crate::desktop::Keep,
    server: Mutex<Option<Arc<Server>>>,
    /// 蓝牙那条线（开着才有）
    bt: Mutex<Option<crate::phone_bt::BtServer>>,
    /// 用户想开蓝牙服务（开不成时后台会一直重试）
    bt_want: AtomicBool,
    bt_retrying: AtomicBool,
    /// 看门狗走了几轮（每 5 秒一轮）
    bt_tick: AtomicU64,
    /// 证书放在哪个文件夹（配置文件夹）
    cert_dir: PathBuf,
    snap: Arc<Mutex<Snapshot>>,
    /// 手机最近一次来要状态的时间（毫秒）；有人在看时才让系统状态线程干活
    last_poll: AtomicU64,
    watching: AtomicBool,
    /// 手机当手柄（见 phone_pad.rs）
    pad: Arc<crate::phone_pad::PhonePad>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 32 位十六进制的随机密钥（系统的加密随机数）
pub fn new_token() -> String {
    let mut b = [0u8; 16];
    unsafe {
        let _ = windows::Win32::Security::Cryptography::BCryptGenRandom(
            None,
            &mut b,
            windows::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        );
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 本机在局域网里的地址（UDP 连一下外网地址只是让系统选网卡，不会真的发包）
pub fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    Some(s.local_addr().ok()?.ip())
}

/// 只认局域网和本机
fn is_local(addr: Option<&SocketAddr>) -> bool {
    match addr.map(|a| a.ip()) {
        Some(IpAddr::V4(v)) => v.is_private() || v.is_loopback() || v.is_link_local(),
        Some(IpAddr::V6(v)) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return v4.is_private() || v4.is_loopback() || v4.is_link_local();
            }
            let seg = v.segments()[0];
            v.is_loopback() || (seg & 0xfe00) == 0xfc00 || (seg & 0xffc0) == 0xfe80
        }
        None => false,
    }
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 封面的编号（内容变了编号就变），手机看到编号变了才去要封面
fn cover_id(cover: &str) -> String {
    use std::hash::{Hash, Hasher};
    if cover.is_empty() {
        return String::new();
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cover.hash(&mut h);
    format!("{:x}", h.finish())
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

/// 一个回应。和传输方式无关：https（浏览器）和蓝牙（手机 App）共用同一套处理
pub struct Resp {
    pub status: u16,
    pub ctype: &'static str,
    pub body: Vec<u8>,
}

fn json_resp(v: Value) -> Resp {
    Resp { status: 200, ctype: "application/json; charset=utf-8", body: v.to_string().into_bytes() }
}

fn text_resp(code: u16, msg: &str) -> Resp {
    Resp { status: code, ctype: "text/plain; charset=utf-8", body: msg.as_bytes().to_vec() }
}

/// 把文字放进剪贴板（Unicode 文本）
fn set_clipboard(text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_UNICODETEXT: u32 = 13;
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        // 剪贴板可能正被别的程序占着：试几次
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
        if !opened {
            return Err("剪贴板被别的程序占着".into());
        }
        let r = (|| {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
            let p = GlobalLock(mem) as *mut u16;
            if p.is_null() {
                return Err("内存锁不住".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
            let _ = GlobalUnlock(mem);
            // 成功后这块内存归系统管，不用自己释放
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(mem.0))).map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = CloseClipboard();
        r
    }
}

/// 只留文件名的最后一段，去掉 Windows 不允许的字符
fn safe_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = last.chars().map(|c| if "<>:\"|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() { format!("手机文件-{}", now_ms()) } else { cleaned }
}

impl Phone {
    pub fn new(app: &AppHandle, token: String, port: u16, shelf_dir: Option<PathBuf>, keep: crate::desktop::Keep, cert_dir: PathBuf) -> Arc<Phone> {
        let phone = Arc::new(Phone {
            app: app.clone(),
            token,
            port,
            shelf_dir,
            keep,
            server: Mutex::new(None),
            bt: Mutex::new(None),
            bt_want: AtomicBool::new(false),
            bt_retrying: AtomicBool::new(false),
            bt_tick: AtomicU64::new(0),
            cert_dir,
            snap: Arc::new(Mutex::new(Snapshot::default())),
            last_poll: AtomicU64::new(0),
            watching: AtomicBool::new(false),
            pad: crate::phone_pad::PhonePad::new(),
        });
        // 收集程序里本来就在广播的状态（灵动岛、小组件也在用）
        let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
        let s = phone.snap.clone();
        app.listen_any("media", move |e| s.lock().unwrap().media = parse(e.payload()));
        let s = phone.snap.clone();
        app.listen_any("media-cover", move |e| s.lock().unwrap().cover = serde_json::from_str::<String>(e.payload()).unwrap_or_default());
        let s = phone.snap.clone();
        app.listen_any("pomodoro", move |e| s.lock().unwrap().pomo = parse(e.payload()));
        let s = phone.snap.clone();
        app.listen_any("sysstat", move |e| s.lock().unwrap().stat = parse(e.payload()));
        // 手机不看了（15 秒没来要状态）就让系统状态线程歇着
        let me = phone.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            // 蓝牙服务要开着却没开成 / 坏了：再试一次（只在第一次失败时打日志，免得刷屏）
            if me.bt_want.load(Ordering::SeqCst) {
                let tick = me.bt_tick.fetch_add(1, Ordering::SeqCst);
                let broken = {
                    let mut bt = me.bt.lock().unwrap();
                    match bt.as_mut() {
                        None => true,
                        Some(b) if b.dead.load(Ordering::SeqCst) => true,
                        // 每 30 秒补登一次服务（登记被蓝牙重启冲掉时手机会连不上）；补登失败就当坏了重开
                        Some(b) => tick % 6 == 5 && b.clients.load(Ordering::SeqCst) == 0 && !b.refresh(),
                    }
                };
                if broken {
                    me.bt.lock().unwrap().take();
                    match me.start_bt() {
                        Ok(()) => eprintln!("蓝牙遥控：重新开好了"),
                        Err(e) => {
                            if !me.bt_retrying.swap(true, Ordering::SeqCst) {
                                eprintln!("蓝牙遥控还没开成：{e}，每 5 秒再试");
                            }
                        }
                    }
                } else {
                    me.bt_retrying.store(false, Ordering::SeqCst);
                }
            }
            if me.watching.load(Ordering::SeqCst) && now_ms().saturating_sub(me.last_poll.load(Ordering::SeqCst)) > 15_000 {
                me.watching.store(false, Ordering::SeqCst);
                if let Some(st) = me.app.try_state::<Arc<crate::sysstat::SysStat>>() {
                    st.watch(false);
                }
            }
        });
        phone
    }

    pub fn running(&self) -> bool {
        self.server.lock().unwrap().is_some()
    }

    /// 手机上要打开的地址（带密钥）
    pub fn url(&self) -> String {
        let ip = lan_ip().map(|i| i.to_string()).unwrap_or_else(|| "电脑的IP".into());
        format!("https://{ip}:{}/?k={}", self.port, self.token)
    }

    /// 二维码（SVG）
    pub fn qr_svg(&self) -> String {
        match qrcode::QrCode::new(self.url().as_bytes()) {
            Ok(code) => code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(240, 240)
                .quiet_zone(true)
                .build(),
            Err(_) => String::new(),
        }
    }

    /// https 证书：配置文件夹里有、并且是给现在这个局域网地址的就用；没有（或电脑地址变了）就生成一张新的存起来。
    /// 证书一直用同一张，手机只在第一次（或换了证书时）提示一次"不安全"
    fn ssl(&self) -> Result<tiny_http::SslConfig, String> {
        let ip = lan_ip().map(|i| i.to_string()).unwrap_or_default();
        let (cert_p, key_p, ip_p) = (self.cert_dir.join("phone-cert.pem"), self.cert_dir.join("phone-key.pem"), self.cert_dir.join("phone-cert-ip.txt"));
        let saved = (std::fs::read(&cert_p), std::fs::read(&key_p), std::fs::read_to_string(&ip_p));
        if let (Ok(certificate), Ok(private_key), Ok(old_ip)) = saved {
            if old_ip.trim() == ip {
                return Ok(tiny_http::SslConfig { certificate, private_key });
            }
        }
        let mut names = vec!["localhost".to_string()];
        if !ip.is_empty() {
            names.insert(0, ip.clone());
        }
        let cert = rcgen::generate_simple_self_signed(names).map_err(|e| format!("证书生成失败：{e}"))?;
        let pem = cert.serialize_pem().map_err(|e| format!("证书生成失败：{e}"))?;
        let key = cert.serialize_private_key_pem();
        let _ = std::fs::create_dir_all(&self.cert_dir);
        let _ = std::fs::write(&cert_p, &pem);
        let _ = std::fs::write(&key_p, &key);
        let _ = std::fs::write(&ip_p, &ip);
        eprintln!("手机遥控：生成了新的 https 证书（{ip}）");
        Ok(tiny_http::SslConfig { certificate: pem.into_bytes(), private_key: key.into_bytes() })
    }

    /// 开始监听
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        let ssl = self.ssl()?;
        let server = Arc::new(Server::https(("0.0.0.0", self.port), ssl).map_err(|e| format!("端口 {} 开不了：{e}", self.port))?);
        *self.server.lock().unwrap() = Some(server.clone());
        // 让媒体模块把当前在放的歌重推一遍，手机一打开就有
        if let Some(tx) = self.app.try_state::<crate::media::MediaTx>() {
            let _ = tx.0.send(crate::media::Msg::Resync);
        }
        if let Some(p) = self.app.try_state::<Arc<crate::pomodoro::Pomodoro>>() {
            self.snap.lock().unwrap().pomo = serde_json::to_value(p.get()).unwrap_or(Value::Null);
        }
        let me = self.clone();
        thread::spawn(move || {
            for rq in server.incoming_requests() {
                let me = me.clone();
                // 传大文件时不挡住别的请求
                thread::spawn(move || me.handle(rq));
            }
        });
        eprintln!("手机遥控已开启：{}", self.url());
        Ok(())
    }

    /// 开蓝牙服务（和 https 互不影响，可以只开一个）
    /// 开蓝牙服务。开不成（刚开机蓝牙还没好、蓝牙关着）也记住"要开"，后台每 5 秒再试，
    /// 中途蓝牙被关掉 / 重启导致服务坏了也会自动重开
    pub fn start_bt(self: &Arc<Self>) -> Result<(), String> {
        self.bt_want.store(true, Ordering::SeqCst);
        let mut bt = self.bt.lock().unwrap();
        if bt.as_ref().is_some_and(|b| b.dead.load(Ordering::SeqCst)) {
            bt.take();
        }
        if bt.is_none() {
            *bt = Some(crate::phone_bt::BtServer::start(self.clone())?);
        }
        Ok(())
    }

    pub fn stop_bt(&self) {
        self.bt_want.store(false, Ordering::SeqCst);
        self.bt.lock().unwrap().take();
    }

    /// 托盘上的勾：用户想开着就算开着（正在等蓝牙准备好也算）
    pub fn bt_running(&self) -> bool {
        self.bt_want.load(Ordering::SeqCst)
    }

    /// 现在有几台手机用蓝牙连着
    pub fn bt_clients(&self) -> usize {
        self.bt.lock().unwrap().as_ref().map_or(0, |b| b.clients.load(Ordering::SeqCst))
    }

    pub fn stop(&self) {
        if let Some(s) = self.server.lock().unwrap().take() {
            s.unblock();
            eprintln!("手机遥控已关闭");
        }
    }

    fn handle(&self, mut rq: Request) {
        let reply = |rq: Request, r: Resp| {
            let _ = rq.respond(Response::from_data(r.body).with_status_code(r.status).with_header(header("Content-Type", r.ctype)));
        };
        if !is_local(rq.remote_addr()) {
            return reply(rq, text_resp(403, "只接受家里局域网的连接"));
        }
        let url = rq.url().to_string();
        let key = query(&url, "k").or_else(|| {
            rq.headers().iter().find(|h| h.field.equiv("X-Key")).map(|h| h.value.as_str().to_string())
        });
        if key.as_deref() != Some(self.token.as_str()) {
            return reply(rq, text_resp(403, "密钥不对：请重新扫电脑上的二维码（托盘 → 手机遥控 → 显示二维码）"));
        }
        let method = match rq.method() {
            Method::Get => "GET",
            Method::Post => "POST",
            _ => "",
        };
        let len = rq.body_length().map(|n| n as u64);
        let r = self.route(method, &url, rq.as_reader(), len);
        reply(rq, r);
    }

    /// 按路径处理一个请求（密钥、来源已经由各自的传输方式检查过）
    pub fn route(&self, method: &str, url: &str, body: &mut dyn Read, body_len: Option<u64>) -> Resp {
        let path = url.split('?').next().unwrap_or("/");
        match (method, path) {
            ("GET", "/") => Resp { status: 200, ctype: "text/html; charset=utf-8", body: PAGE.as_bytes().to_vec() },
            ("GET", "/api/state") => json_resp(self.state()),
            ("GET", "/api/cover") => json_resp(json!({ "cover": self.snap.lock().unwrap().cover })),
            ("POST", p) if p.starts_with("/api/media/") => {
                let msg = match &p[11..] {
                    "toggle" => Some(crate::media::Msg::Toggle),
                    "next" => Some(crate::media::Msg::Next),
                    "prev" => Some(crate::media::Msg::Prev),
                    _ => None,
                };
                match (msg, self.app.try_state::<crate::media::MediaTx>()) {
                    (Some(m), Some(tx)) => {
                        let _ = tx.0.send(m);
                        json_resp(json!({ "ok": true }))
                    }
                    _ => text_resp(400, "不认识的操作"),
                }
            }
            ("POST", p) if p.starts_with("/api/pomodoro/") => {
                let a = &p[14..];
                match (["start", "pause", "resume", "cancel", "dismiss"].contains(&a), self.app.try_state::<Arc<crate::pomodoro::Pomodoro>>()) {
                    (true, Some(pomo)) => json_resp(serde_json::to_value(pomo.act(a)).unwrap_or(Value::Null)),
                    _ => text_resp(400, "不认识的操作"),
                }
            }
            ("POST", "/api/desktop") => {
                crate::desktop::run(crate::desktop::Action::Desktop, self.keep.clone());
                json_resp(json!({ "ok": true }))
            }
            ("POST", "/api/text") => {
                let mut buf = String::new();
                match (&mut *body).take(MAX_TEXT).read_to_string(&mut buf) {
                    Ok(_) if !buf.is_empty() => match set_clipboard(&buf) {
                        Ok(()) => {
                            eprintln!("手机发来文字（{} 字），已放进剪贴板", buf.chars().count());
                            json_resp(json!({ "ok": true }))
                        }
                        Err(e) => text_resp(500, &e),
                    },
                    _ => text_resp(400, "没收到文字"),
                }
            }
            ("POST", "/api/upload") => self.upload(body, body_len, url),
            ("POST", "/api/mouse") => {
                let mut buf = String::new();
                let _ = (&mut *body).take(MAX_MOUSE).read_to_string(&mut buf);
                match serde_json::from_str::<Vec<Value>>(&buf).map_err(|e| e.to_string()).and_then(|l| crate::phone_input::mouse_events(&l)) {
                    Ok(_) => json_resp(json!({ "ok": true })),
                    Err(e) => text_resp(400, &e),
                }
            }
            // 手机当手柄：一帧状态 → 虚拟 Xbox 手柄 / 键盘鼠标
            ("POST", "/api/pad") => {
                let mut buf = String::new();
                let _ = (&mut *body).take(4096).read_to_string(&mut buf);
                match serde_json::from_str::<Value>(&buf) {
                    Ok(v) => {
                        let s = crate::phone_pad::PadState::from_json(&v);
                        let sens = v.get("sens").and_then(Value::as_f64).unwrap_or(1.0);
                        let end = v.get("end").and_then(Value::as_bool).unwrap_or(false);
                        let mode = self.pad.update(s, sens, end);
                        // 键盘模式下前台是管理员身份的程序：模拟的键盘鼠标它收不到
                        let blocked = mode == "keys" && crate::phone_pad::elevated_foreground();
                        json_resp(json!({ "mode": mode, "blocked": blocked }))
                    }
                    Err(_) => text_resp(400, "看不懂"),
                }
            }
            // 游戏触控板：WASD 摇杆、Alt 现在按着哪些键（{"keys":["w","alt"]}）
            ("POST", "/api/keys") => {
                let mut buf = String::new();
                let _ = (&mut *body).take(4096).read_to_string(&mut buf);
                let names: Vec<String> = serde_json::from_str::<Value>(&buf)
                    .ok()
                    .and_then(|v| v.get("keys").and_then(|k| serde_json::from_value(k.clone()).ok()))
                    .unwrap_or_default();
                match self.pad.keys(&names.iter().map(String::as_str).collect::<Vec<_>>()) {
                    Ok(()) => json_resp(json!({ "ok": true, "blocked": crate::phone_pad::elevated_foreground() })),
                    Err(e) => text_resp(400, &e),
                }
            }
            ("GET", "/api/windows") => json_resp(crate::phone_input::list_windows()),
            ("POST", "/api/windows/switch") => match query(url, "id").and_then(|v| v.parse::<isize>().ok()) {
                Some(id) => match crate::phone_input::switch_to(id) {
                    Ok(()) => json_resp(json!({ "ok": true })),
                    Err(e) => text_resp(409, &e),
                },
                None => text_resp(400, "没说切到哪个窗口"),
            },
            // ---------- 音游（手机模式）：手机选歌、点靶子，电脑照常放歌和画裂缝 ----------
            ("GET", "/api/time") => json_resp(json!({ "now": now_ms() })),
            ("GET", "/api/rhythm/songs") => json_resp(serde_json::to_value(crate::rhythm_songs(self.app.clone())).unwrap_or(Value::Null)),
            ("GET", "/api/rhythm/categories") => json_resp(serde_json::to_value(crate::rhythm_categories_get(self.app.clone())).unwrap_or(Value::Null)),
            ("POST", "/api/rhythm/open") => {
                // 电脑回到桌面（已经在桌面就不按，免得又切回去），弹出选歌菜单
                if !crate::phone_input::at_desktop() {
                    crate::desktop::run(crate::desktop::Action::Desktop, self.keep.clone());
                }
                crate::phone_input::nudge();
                let _ = self.app.emit_to("widgets", "phone-rhythm", ());
                json_resp(json!({ "ok": true }))
            }
            ("POST", "/api/rhythm/play") => {
                let (id, c, d) = (query(url, "id"), query(url, "c"), query(url, "d"));
                match (id, c, d) {
                    (Some(id), Some(characteristic), Some(difficulty)) => {
                        // 电脑上的选歌菜单收起来，打开裂缝
                        if let Some(w) = self.app.try_state::<Arc<crate::widgets::Widgets>>() {
                            w.set_rhythm(false);
                        }
                        let _ = self.app.emit_to("widgets", "phone-rhythm-close", ());
                        crate::phone_input::nudge();
                        crate::rift::open_pick(&self.app, crate::rift::Pick { id, characteristic, difficulty, phone: true });
                        json_resp(json!({ "ok": true }))
                    }
                    _ => text_resp(400, "没说玩哪首"),
                }
            }
            ("GET", "/api/rhythm/state") => json_resp(crate::rift::phone_state()),
            ("GET", "/api/rhythm/plan") => json_resp(crate::rift::phone_plan()),
            ("POST", "/api/rhythm/hit") => {
                let mut buf = String::new();
                let _ = (&mut *body).take(4096).read_to_string(&mut buf);
                match serde_json::from_str::<Value>(&buf) {
                    Ok(v) => {
                        let _ = self.app.emit_to(crate::rift::LABEL, "rift-phone-hit", v);
                        json_resp(json!({ "ok": true }))
                    }
                    Err(_) => text_resp(400, "看不懂"),
                }
            }
            ("POST", p) if p.starts_with("/api/rhythm/cmd/") => {
                let a = &p[16..];
                if ["start", "pause", "resume", "restart", "quit"].contains(&a) {
                    let _ = self.app.emit_to(crate::rift::LABEL, "rift-phone-cmd", a);
                    json_resp(json!({ "ok": true }))
                } else {
                    text_resp(400, "不认识的操作")
                }
            }
            ("POST", "/api/alttab") => {
                crate::phone_input::alt_tab();
                json_resp(json!({ "ok": true }))
            }
            _ => text_resp(404, "没有这个"),
        }
    }

    fn state(&self) -> Value {
        self.last_poll.store(now_ms(), Ordering::SeqCst);
        // 有人在看：让系统状态线程开始读 CPU / 温度 / 电量
        if !self.watching.swap(true, Ordering::SeqCst) {
            if let Some(st) = self.app.try_state::<Arc<crate::sysstat::SysStat>>() {
                let first = st.watch(true);
                let mut s = self.snap.lock().unwrap();
                if s.stat.is_null() {
                    s.stat = serde_json::to_value(first).unwrap_or(Value::Null);
                }
            }
        }
        let s = self.snap.lock().unwrap();
        let shelf = self.shelf_dir.is_some();
        json!({
            "media": s.media,
            "coverId": cover_id(&s.cover),
            "pomo": s.pomo,
            "stat": s.stat,
            "upload": shelf,
            "now": now_ms(),
            // 前台是管理员身份的程序：触控板（模拟鼠标）控制不了它
            "blocked": crate::phone_pad::elevated_foreground(),
        })
    }

    fn upload(&self, body: &mut dyn Read, body_len: Option<u64>, url: &str) -> Resp {
        let Some(root) = &self.shelf_dir else { return text_resp(400, "架子没开，不能收文件") };
        let len = body_len.unwrap_or(0);
        if len > MAX_UPLOAD {
            return text_resp(413, "文件太大（最大 1GB）");
        }
        let name = safe_name(&query(url, "name").unwrap_or_default());
        let dir = root.join("手机");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return text_resp(500, &format!("建不了文件夹：{e}"));
        }
        // 重名自动改名，绝不覆盖；先写到系统临时文件夹（架子里不会出现写了一半的文件），写完整了再挪进来
        let target = crate::fileops::unique_target(&dir, &name, false);
        let tmp = std::env::temp_dir().join(format!("desktop-island-phone-{}.part", now_ms()));
        let result = (|| -> std::io::Result<u64> {
            let mut f = std::fs::File::create(&tmp)?;
            let n = std::io::copy(&mut body.take(MAX_UPLOAD + 1), &mut f)?;
            if n > MAX_UPLOAD {
                return Err(std::io::Error::other("文件太大"));
            }
            f.sync_all()?;
            Ok(n)
        })();
        match result {
            Ok(n) => {
                // 改名时再确认一次没被占（写的过程中可能有同名文件出现）
                let target = if target.exists() { crate::fileops::unique_target(&dir, &name, false) } else { target };
                // 同一个盘直接改名；跨盘（比如架子在别的盘）就复制过去
                let moved = std::fs::rename(&tmp, &target).or_else(|_| std::fs::copy(&tmp, &target).map(|_| ()));
                // 临时文件是我们自己刚写的，用完清掉
                let _ = std::fs::remove_file(&tmp);
                if let Err(e) = moved {
                    return text_resp(500, &format!("存不了：{e}"));
                }
                let saved = target.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                eprintln!("手机传来文件：{saved}（{n} 字节）");
                json_resp(json!({ "ok": true, "name": saved, "bytes": n }))
            }
            Err(e) => {
                // 只清掉自己刚写的临时文件
                let _ = std::fs::remove_file(&tmp);
                text_resp(500, &format!("没传完：{e}"))
            }
        }
    }
}

impl crate::phone_bt::Route for Phone {
    fn route(&self, method: &str, url: &str, body: &mut dyn Read, body_len: Option<u64>) -> Resp {
        Phone::route(self, method, url, body, body_len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_lan_addresses() {
        let a = |s: &str| is_local(Some(&s.parse::<SocketAddr>().unwrap()));
        assert!(a("192.168.1.5:1234"));
        assert!(a("10.0.0.2:1"));
        assert!(a("172.20.3.4:1"));
        assert!(a("127.0.0.1:1"));
        assert!(a("[fe80::1]:1"));
        assert!(!a("8.8.8.8:1"));
        assert!(!a("172.32.0.1:1"));
        assert!(!a("[2001:db8::1]:1"));
        assert!(!is_local(None));
    }

    #[test]
    fn names_and_queries() {
        assert_eq!(safe_name("../../Windows/evil.exe"), "evil.exe");
        assert_eq!(safe_name("C:\\a\\b\\照片 1.jpg"), "照片 1.jpg");
        assert_eq!(safe_name("a<b>:c?.txt"), "a_b__c_.txt");
        assert!(safe_name("..").starts_with("手机文件-"));
        assert_eq!(query("/api/upload?name=%E7%85%A7%E7%89%87.jpg&k=x", "name").unwrap(), "照片.jpg");
        assert_eq!(query("/?k=abc", "k").unwrap(), "abc");
        assert_eq!(new_token().len(), 32);
    }
}
