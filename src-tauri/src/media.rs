//! 正在播放的媒体：Windows 媒体会话接口（GlobalSystemMediaTransportControlsSessionManager）。
//! 完全事件驱动，不轮询：系统通知"有变化"时才读取一次并推送给页面。

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::Interface;
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

pub enum Msg {
    Refresh,
    /// 歌曲信息（标题、歌手、封面）变了：封面要重新读
    PropsChanged,
    /// 页面刚加载好：强制把当前状态和封面重新推一遍
    Resync,
    Toggle,
    Next,
    Prev,
}

/// 页面那边持有的发送端
pub struct MediaTx(pub Sender<Msg>);

#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub active: bool,
    pub title: String,
    pub artist: String,
    pub source: String,
    pub playing: bool,
    /// 读取时刻的播放位置；页面用收到事件的时间自己往前推
    pub position_ms: i64,
    pub duration_ms: i64,
    pub can_toggle: bool,
    pub can_next: bool,
    pub can_prev: bool,
}

/// 封面最大 4MB，超过就不要了
const MAX_COVER: u32 = 4 * 1024 * 1024;
/// 系统常常连发好几个事件，攒 40ms 一起处理
const DEBOUNCE: Duration = Duration::from_millis(40);
/// 换歌后过这么久再补读一次封面：浏览器常常先报标题、封面图稍后才下载好
const COVER_RETRIES: [Duration; 2] = [Duration::from_millis(1500), Duration::from_millis(4000)];

pub fn spawn(app: AppHandle) -> Sender<Msg> {
    let (tx, rx) = channel();
    let tx2 = tx.clone();
    thread::spawn(move || {
        // 读不到就安静退出，胶囊照常显示时间
        if let Err(e) = run(app, tx2, rx) {
            eprintln!("媒体模块不可用: {e:?}");
        }
    });
    tx
}

struct Sub {
    session: Session,
    tokens: [i64; 3],
}

fn subscribe(s: &Session, tx: &Sender<Msg>) -> windows::core::Result<[i64; 3]> {
    let (a, b, c) = (tx.clone(), tx.clone(), tx.clone());
    Ok([
        s.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = a.send(Msg::PropsChanged);
            Ok(())
        }))?,
        s.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            let _ = b.send(Msg::Refresh);
            Ok(())
        }))?,
        s.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = c.send(Msg::Refresh);
            Ok(())
        }))?,
    ])
}

fn unsubscribe(sub: &Sub) {
    let _ = sub.session.RemoveMediaPropertiesChanged(sub.tokens[0]);
    let _ = sub.session.RemovePlaybackInfoChanged(sub.tokens[1]);
    let _ = sub.session.RemoveTimelinePropertiesChanged(sub.tokens[2]);
}

fn run(app: AppHandle, tx: Sender<Msg>, rx: Receiver<Msg>) -> windows::core::Result<()> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let mgr = Manager::RequestAsync()?.join()?;

    let t = tx.clone();
    mgr.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        let _ = t.send(Msg::Refresh);
        Ok(())
    }))?;
    let t = tx.clone();
    mgr.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        let _ = t.send(Msg::Refresh);
        Ok(())
    }))?;

    let mut subs: Vec<Sub> = Vec::new();
    let mut current: Option<Session> = None;
    let mut last_info: Option<MediaInfo> = None;
    let mut cover_key = String::new();
    let mut last_cover: Vec<u8> = Vec::new();

    // 换歌后排好的封面补读时间点；没有计划时就一直睡到有事件
    let mut cover_retries: Vec<Instant> = Vec::new();

    let _ = tx.send(Msg::Refresh);
    loop {
        let first = match cover_retries.iter().min() {
            Some(&at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return Ok(()),
            },
        };
        // 到了补读时间（等待超时）也要重新读封面
        let mut refetch_cover = first.is_none();
        let mut force = false;
        let mut handle = |m: &Msg, cur: Option<&Session>| {
            force |= matches!(m, Msg::Resync);
            refetch_cover |= matches!(m, Msg::PropsChanged);
            control(m, cur);
        };
        if let Some(m) = &first {
            handle(m, current.as_ref());
        }
        // 合并紧接着到来的消息
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(m) => handle(&m, current.as_ref()),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
        let now = Instant::now();
        cover_retries.retain(|t| *t > now);

        if force {
            last_info = None;
            last_cover.clear();
            cover_key.clear();
        }

        let sessions: Vec<Session> = mgr.GetSessions()?.into_iter().collect();

        // 会话列表变了才重新订阅
        let same = subs.len() == sessions.len()
            && subs.iter().zip(&sessions).all(|(a, b)| a.session.as_raw() == b.as_raw());
        if !same {
            subs.iter().for_each(unsubscribe);
            subs = sessions
                .iter()
                .filter_map(|s| subscribe(s, &tx).ok().map(|tokens| Sub { session: s.clone(), tokens }))
                .collect();
        }

        current = pick(&mgr, &sessions);
        let info = current.as_ref().and_then(|s| read_info(s).ok()).unwrap_or_default();

        if last_info.as_ref() != Some(&info) {
            let _ = app.emit("media", &info);
            last_info = Some(info.clone());
        }

        // 封面在换歌、歌曲信息变化、之前没拿到、或到了补读时间时读取；
        // 读到的和上次一样就不推送，页面不会白白刷新
        let key = format!("{}|{}|{}", info.source, info.title, info.artist);
        if info.active && (key != cover_key || last_cover.is_empty() || refetch_cover) {
            if key != cover_key {
                cover_retries = COVER_RETRIES.iter().map(|d| now + *d).collect();
            }
            cover_key = key;
            let bytes = current.as_ref().and_then(|s| read_cover(s).ok()).unwrap_or_default();
            if bytes.0 != last_cover {
                let url = if bytes.0.is_empty() {
                    String::new()
                } else {
                    format!(
                        "data:{};base64,{}",
                        bytes.1,
                        base64::engine::general_purpose::STANDARD.encode(&bytes.0)
                    )
                };
                let _ = app.emit("media-cover", url);
                last_cover = bytes.0;
            }
        } else if !info.active && !last_cover.is_empty() {
            cover_retries.clear();
            cover_key.clear();
            last_cover.clear();
            let _ = app.emit("media-cover", String::new());
        }
    }
}

fn control(msg: &Msg, s: Option<&Session>) {
    let Some(s) = s else { return };
    let _ = match msg {
        Msg::Toggle => s.TryTogglePlayPauseAsync().and_then(|op| op.join()),
        Msg::Next => s.TrySkipNextAsync().and_then(|op| op.join()),
        Msg::Prev => s.TrySkipPreviousAsync().and_then(|op| op.join()),
        Msg::Refresh | Msg::Resync | Msg::PropsChanged => Ok(true),
    };
}

fn is_playing(s: &Session) -> bool {
    s.GetPlaybackInfo()
        .and_then(|p| p.PlaybackStatus())
        .map(|st| st == Status::Playing)
        .unwrap_or(false)
}

/// 选哪个会话：系统当前会话在播就用它；否则任意一个在播的；都没在播就用系统当前会话（显示暂停状态）
fn pick(mgr: &Manager, sessions: &[Session]) -> Option<Session> {
    let cur = mgr.GetCurrentSession().ok();
    if let Some(c) = &cur {
        if is_playing(c) {
            return cur;
        }
    }
    sessions.iter().find(|s| is_playing(s)).cloned().or(cur)
}

/// 现在的时间，换成 Windows 的 100 纳秒刻度（从 1601 年起）
fn now_ticks() -> i64 {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (d.as_nanos() / 100) as i64 + 116_444_736_000_000_000
}

fn read_info(s: &Session) -> windows::core::Result<MediaInfo> {
    let props = s.TryGetMediaPropertiesAsync()?.join()?;
    let pb = s.GetPlaybackInfo()?;
    let controls = pb.Controls()?;
    let tl = s.GetTimelineProperties()?;
    let playing = pb.PlaybackStatus()? == Status::Playing;

    let start = tl.StartTime()?.Duration;
    let end = tl.EndTime()?.Duration;
    let duration = (end - start).max(0);
    let mut pos = tl.Position()?.Duration - start;
    if playing {
        pos += (now_ticks() - tl.LastUpdatedTime()?.UniversalTime).max(0);
    }
    let pos = pos.clamp(0, duration.max(0));

    let title = props.Title()?.to_string();
    Ok(MediaInfo {
        active: !title.is_empty(),
        title,
        artist: props.Artist()?.to_string(),
        source: s.SourceAppUserModelId()?.to_string(),
        playing,
        position_ms: pos / 10_000,
        duration_ms: duration / 10_000,
        can_toggle: controls.IsPlayPauseToggleEnabled()?,
        can_next: controls.IsNextEnabled()?,
        can_prev: controls.IsPreviousEnabled()?,
    })
}

fn read_cover(s: &Session) -> windows::core::Result<(Vec<u8>, String)> {
    let props = s.TryGetMediaPropertiesAsync()?.join()?;
    let stream = props.Thumbnail()?.OpenReadAsync()?.join()?;
    let size = stream.Size()? as u32;
    if size == 0 || size > MAX_COVER {
        return Ok((Vec::new(), String::new()));
    }
    let mime = stream.ContentType().map(|m| m.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size)?.join()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;
    let mime = if mime.starts_with("image/") { mime } else { "image/png".into() };
    Ok((buf, mime))
}
