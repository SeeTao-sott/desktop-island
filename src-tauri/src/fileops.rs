//! 安全的文件移动。规则：
//! - 绝不覆盖：系统移动/复制都不带"覆盖"选项，目标已存在就换个名字（名字 (2)、名字 (3)…）
//! - 同一硬盘：直接移动（只是改位置，瞬间完成）
//! - 跨硬盘：先复制 → 逐字节比对确认完全一样 → 才移除原件；任何一步出错都保留原件
//! - 出错时给清楚的中文说明；被占用时说出是哪个程序

use std::fs::{self, File};
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_DISK_FULL, ERROR_FILENAME_EXCED_RANGE, ERROR_FILE_EXISTS,
    ERROR_FILE_NOT_FOUND, ERROR_HANDLE_DISK_FULL, ERROR_INVALID_NAME, ERROR_LOCK_VIOLATION, ERROR_NOT_SAME_DEVICE,
    ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION, WIN32_ERROR,
};
use windows::Win32::Storage::FileSystem::{
    CopyFileExW, CreateFileW, MoveFileExW, COPY_FILE_FAIL_IF_EXISTS, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, MOVE_FILE_FLAGS, OPEN_EXISTING,
};
use windows::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, RM_PROCESS_INFO,
};

/// 系统错误码（取不到时为 0）
fn code_of(e: &windows::core::Error) -> u32 {
    let hr = e.code().0 as u32;
    // HRESULT_FROM_WIN32：0x8007xxxx
    if hr & 0xFFFF_0000 == 0x8007_0000 {
        hr & 0xFFFF
    } else {
        0
    }
}

fn io_code(e: &std::io::Error) -> u32 {
    e.raw_os_error().unwrap_or(0) as u32
}

fn is(code: u32, err: WIN32_ERROR) -> bool {
    code == err.0
}

/// 把文件名拆成 主名 + 扩展名（文件夹没有扩展名；".gitignore" 这种整体算主名）
pub fn split_name(name: &str, is_dir: bool) -> (&str, &str) {
    if is_dir {
        return (name, "");
    }
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// 在 dir 里找一个还没被占用的名字：name、name (2)、name (3)…
pub fn unique_target(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = split_name(name, is_dir);
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// 把 src 移进 dir，尽量保持名字 name；重名自动改名。返回最终位置
pub fn move_into(src: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    let is_dir = src.is_dir();
    if !src.exists() && fs::symlink_metadata(src).is_err() {
        return Err("文件已经不在原来的位置了".into());
    }
    fs::create_dir_all(dir).map_err(|e| describe_io(&e, dir))?;
    // 检查和移动之间如果正好有同名文件冒出来，系统会拒绝（不覆盖），换个名字再试
    for _ in 0..20 {
        let dst = unique_target(dir, name, is_dir);
        match move_exact(src, &dst) {
            Ok(()) => return Ok(dst),
            Err(MoveFail::Exists) => continue,
            Err(MoveFail::Msg(m)) => return Err(m),
        }
    }
    Err("一直遇到重名，没有移动".into())
}

enum MoveFail {
    Exists,
    Msg(String),
}

/// 移到确切的目标路径；目标已存在就失败（绝不覆盖）
fn move_exact(src: &Path, dst: &Path) -> Result<(), MoveFail> {
    let (s, d) = (HSTRING::from(src.as_os_str()), HSTRING::from(dst.as_os_str()));
    // 不带 MOVEFILE_REPLACE_EXISTING（不覆盖），也不带 MOVEFILE_COPY_ALLOWED（跨盘自己按安全流程做）
    match unsafe { MoveFileExW(&s, &d, MOVE_FILE_FLAGS(0)) } {
        Ok(()) => Ok(()),
        Err(e) => {
            let c = code_of(&e);
            if is(c, ERROR_ALREADY_EXISTS) || is(c, ERROR_FILE_EXISTS) {
                Err(MoveFail::Exists)
            } else if is(c, ERROR_NOT_SAME_DEVICE) {
                cross_volume(src, dst).map_err(MoveFail::Msg)
            } else {
                Err(MoveFail::Msg(describe(c, src)))
            }
        }
    }
}

// ---------------- 跨硬盘：复制 → 校验 → 移除原件 ----------------

fn cross_volume(src: &Path, dst: &Path) -> Result<(), String> {
    // 先把要搬的东西列出来，并确认每个原文件之后都能移除（没被占用、有权限），否则一开始就不动
    let mut files: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    collect(src, &mut files, &mut dirs)?;
    for f in &files {
        check_removable(f)?;
    }

    // 复制。目标位置全是新建的，出错时只清理我们自己刚复制出来的东西，原件一点不动
    let mut created_files: Vec<PathBuf> = Vec::new();
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<(), String> {
        for d in &dirs {
            let target = map_path(src, dst, d);
            fs::create_dir(&target).map_err(|e| describe_io(&e, &target))?;
            created_dirs.push(target);
        }
        for f in &files {
            let target = map_path(src, dst, f);
            copy_no_overwrite(f, &target)?;
            created_files.push(target.clone());
            if !same_content(f, &target)? {
                return Err(format!("复制后校验不一致：{}", f.display()));
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        for f in created_files.iter().rev() {
            let _ = clear_readonly(f).and_then(|_| fs::remove_file(f));
        }
        for d in created_dirs.iter().rev() {
            let _ = fs::remove_dir(d);
        }
        return Err(format!("{e}（原文件没有动）"));
    }

    // 全部校验通过，才移除原件：逐个删文件，再从最深处删空文件夹（只删空的，不连带删除）
    let mut left = 0;
    for f in &files {
        if clear_readonly(f).and_then(|_| fs::remove_file(f)).is_err() {
            left += 1;
        }
    }
    for d in dirs.iter().rev() {
        let _ = fs::remove_dir(d);
    }
    if left > 0 {
        return Err(format!("已完整复制到新位置，但原位置有 {left} 个文件没能移除（可能被占用），它们还在原处"));
    }
    Ok(())
}

/// 列出 src 下所有文件和文件夹（文件夹按从浅到深）。遇到符号链接为安全起见直接拒绝
fn collect(src: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| describe_io(&e, src))?;
    if meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0 {
        return Err("包含符号链接或联接点，为了安全不跨硬盘移动".into());
    }
    if meta.is_dir() {
        dirs.push(src.to_path_buf());
        for entry in fs::read_dir(src).map_err(|e| describe_io(&e, src))? {
            let entry = entry.map_err(|e| describe_io(&e, src))?;
            collect(&entry.path(), files, dirs)?;
        }
    } else {
        files.push(src.to_path_buf());
    }
    Ok(())
}

fn map_path(src_root: &Path, dst_root: &Path, p: &Path) -> PathBuf {
    match p.strip_prefix(src_root) {
        // 搬的就是这一个文件本身：不能 join("")，那样末尾会多一个 \ 被当成文件夹
        Ok(rel) if rel.as_os_str().is_empty() => dst_root.to_path_buf(),
        Ok(rel) => dst_root.join(rel),
        Err(_) => dst_root.to_path_buf(),
    }
}

fn copy_no_overwrite(from: &Path, to: &Path) -> Result<(), String> {
    let (f, t) = (HSTRING::from(from.as_os_str()), HSTRING::from(to.as_os_str()));
    unsafe { CopyFileExW(&f, &t, None, None, None, COPY_FILE_FAIL_IF_EXISTS) }
        .map_err(|e| describe(code_of(&e), from))
}

/// 逐字节比对两个文件是否完全一样
fn same_content(a: &Path, b: &Path) -> Result<bool, String> {
    let (ma, mb) = (fs::metadata(a), fs::metadata(b));
    match (ma, mb) {
        (Ok(ma), Ok(mb)) if ma.len() != mb.len() => return Ok(false),
        (Err(e), _) => return Err(describe_io(&e, a)),
        (_, Err(e)) => return Err(describe_io(&e, b)),
        _ => {}
    }
    let mut fa = File::open(a).map_err(|e| describe_io(&e, a))?;
    let mut fb = File::open(b).map_err(|e| describe_io(&e, b))?;
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let na = read_full(&mut fa, &mut ba).map_err(|e| describe_io(&e, a))?;
        let nb = read_full(&mut fb, &mut bb).map_err(|e| describe_io(&e, b))?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

fn read_full(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn clear_readonly(p: &Path) -> std::io::Result<()> {
    let mut perm = fs::metadata(p)?.permissions();
    if perm.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(p, perm)?;
    }
    Ok(())
}

/// 只申请"删除"权限打开一下再关掉：能打开说明之后能移除，不会改动文件
pub fn check_removable(p: &Path) -> Result<(), String> {
    let h = HSTRING::from(p.as_os_str());
    let r = unsafe {
        CreateFileW(
            &h,
            0x0001_0000, // DELETE
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    };
    match r {
        Ok(handle) => {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
            }
            Ok(())
        }
        Err(e) => Err(describe(code_of(&e), p)),
    }
}

// ---------------- 错误说明 ----------------

pub fn describe_io(e: &std::io::Error, p: &Path) -> String {
    match io_code(e) {
        0 => format!("{e}"),
        c => describe(c, p),
    }
}

pub fn describe(code: u32, p: &Path) -> String {
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if is(code, ERROR_SHARING_VIOLATION) || is(code, ERROR_LOCK_VIOLATION) {
        let apps = who_uses(p);
        return if apps.is_empty() {
            format!("「{name}」正在被其他程序使用，先关掉它再试")
        } else {
            format!("「{name}」正在被 {} 使用，先关掉它再试", apps.join("、"))
        };
    }
    if is(code, ERROR_ACCESS_DENIED) {
        // 文件夹里有文件开着时，移动文件夹也会报"拒绝访问"
        return if p.is_dir() {
            format!("没法移动「{name}」：没有权限，或者里面有文件正在被使用")
        } else {
            format!("没有权限移动「{name}」（可能需要管理员权限，或文件是只读的系统文件）")
        };
    }
    if is(code, ERROR_FILE_NOT_FOUND) || is(code, ERROR_PATH_NOT_FOUND) {
        return format!("「{name}」已经不在原来的位置了");
    }
    if is(code, ERROR_DISK_FULL) || is(code, ERROR_HANDLE_DISK_FULL) {
        return "磁盘空间不够".into();
    }
    if is(code, ERROR_FILENAME_EXCED_RANGE) {
        return format!("「{name}」的路径太长了");
    }
    if is(code, ERROR_INVALID_NAME) {
        return format!("「{name}」这个名字不能用");
    }
    format!("移动「{name}」失败（系统错误 {code}）")
}

/// 用系统的重启管理器查出是哪些程序占用着这个文件（只读查询）
fn who_uses(p: &Path) -> Vec<String> {
    if p.is_dir() {
        return Vec::new();
    }
    unsafe {
        let mut session = 0u32;
        let mut key = [0u16; 64];
        if RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())).is_err() {
            return Vec::new();
        }
        let wide = HSTRING::from(p.as_os_str());
        let mut apps = Vec::new();
        if RmRegisterResources(session, Some(&[PCWSTR(wide.as_ptr())]), None, None).is_ok() {
            let (mut needed, mut count, mut reasons) = (0u32, 8u32, 0u32);
            let mut infos = vec![RM_PROCESS_INFO::default(); 8];
            if RmGetList(session, &mut needed, &mut count, Some(infos.as_mut_ptr()), &mut reasons).is_ok() {
                for info in &infos[..count as usize] {
                    let n = info.strAppName.iter().position(|&c| c == 0).unwrap_or(info.strAppName.len());
                    let name = String::from_utf16_lossy(&info.strAppName[..n]);
                    if !name.is_empty() && !apps.contains(&name) {
                        apps.push(name);
                    }
                }
            }
        }
        let _ = RmEndSession(session);
        apps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个独立的临时文件夹
    fn scratch(base: &Path, tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = base.join(format!("island-fileops-{tag}-{n}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unique_names() {
        let d = scratch(&std::env::temp_dir(), "unique");
        fs::write(d.join("a.txt"), "1").unwrap();
        fs::write(d.join("a (2).txt"), "2").unwrap();
        assert_eq!(unique_target(&d, "a.txt", false), d.join("a (3).txt"));
        assert_eq!(unique_target(&d, "b.txt", false), d.join("b.txt"));
        fs::create_dir(d.join("文件夹")).unwrap();
        assert_eq!(unique_target(&d, "文件夹", true), d.join("文件夹 (2)"));
        assert_eq!(split_name(".gitignore", false), (".gitignore", ""));
        assert_eq!(split_name("v1.2.zip", false), ("v1.2", ".zip"));
    }

    #[test]
    fn same_volume_never_overwrites() {
        let base = scratch(&std::env::temp_dir(), "same");
        let (src_dir, dst_dir) = (base.join("src"), base.join("dst"));
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("笔记.txt"), "新的").unwrap();
        fs::write(dst_dir.join("笔记.txt"), "原来就在的").unwrap();

        let to = move_into(&src_dir.join("笔记.txt"), &dst_dir, "笔记.txt").unwrap();
        assert_eq!(to, dst_dir.join("笔记 (2).txt"));
        assert_eq!(fs::read_to_string(&to).unwrap(), "新的");
        // 原来就在的那个文件一个字都没变
        assert_eq!(fs::read_to_string(dst_dir.join("笔记.txt")).unwrap(), "原来就在的");
        assert!(!src_dir.join("笔记.txt").exists());
    }

    #[test]
    fn cross_volume_file_and_folder() {
        // 源在 D 盘（项目的编译目录里），目标在 C 盘临时文件夹：真正的跨硬盘
        let d_base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        if !d_base.exists() || d_base.to_string_lossy().to_lowercase().starts_with("c:") {
            return;
        }
        let src = scratch(&d_base, "xsrc");
        let dst = scratch(&std::env::temp_dir(), "xdst");

        // 单个文件：内容要一模一样，原件要没了
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i * 7 % 251) as u8).collect();
        fs::write(src.join("大文件.bin"), &data).unwrap();
        let to = move_into(&src.join("大文件.bin"), &dst, "大文件.bin").unwrap();
        assert_eq!(fs::read(&to).unwrap(), data);
        assert!(!src.join("大文件.bin").exists());

        // 文件夹（带子文件夹）
        let folder = src.join("资料");
        fs::create_dir_all(folder.join("子文件夹")).unwrap();
        fs::write(folder.join("a.txt"), "甲").unwrap();
        fs::write(folder.join("子文件夹").join("b.txt"), "乙").unwrap();
        let to = move_into(&folder, &dst, "资料").unwrap();
        assert_eq!(fs::read_to_string(to.join("a.txt")).unwrap(), "甲");
        assert_eq!(fs::read_to_string(to.join("子文件夹").join("b.txt")).unwrap(), "乙");
        assert!(!folder.exists());

        // 目标已有同名文件夹：自动改名，原有的不动
        fs::create_dir_all(src.join("资料")).unwrap();
        fs::write(src.join("资料").join("c.txt"), "丙").unwrap();
        let to2 = move_into(&src.join("资料"), &dst, "资料").unwrap();
        assert_eq!(to2, dst.join("资料 (2)"));
        assert_eq!(fs::read_to_string(dst.join("资料").join("a.txt")).unwrap(), "甲");
        assert_eq!(fs::read_to_string(to2.join("c.txt")).unwrap(), "丙");
    }

    #[test]
    fn locked_file_is_not_moved_across_volumes() {
        let d_base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        if !d_base.exists() || d_base.to_string_lossy().to_lowercase().starts_with("c:") {
            return;
        }
        let src = scratch(&d_base, "lsrc");
        let dst = scratch(&std::env::temp_dir(), "ldst");
        let f = src.join("占用中.txt");
        fs::write(&f, "别动我").unwrap();
        // 用"不允许别人删除"的方式打开，模拟被其他程序占用
        use std::os::windows::fs::OpenOptionsExt;
        let _lock = fs::OpenOptions::new().read(true).share_mode(0x1).open(&f).unwrap();
        let err = move_into(&f, &dst, "占用中.txt").unwrap_err();
        assert!(err.contains("正在被"), "{err}");
        // 原件还在、目标没有残留
        assert_eq!(fs::read_to_string(&f).unwrap(), "别动我");
        assert!(fs::read_dir(&dst).unwrap().next().is_none());
    }
}
