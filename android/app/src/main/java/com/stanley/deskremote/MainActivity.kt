package com.stanley.deskremote

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * 「桌面遥控」：把电脑上的手机遥控网页（打包在 App 里）显示出来，网页的请求都经蓝牙送到电脑。
 *
 * 网页从 https://appassets.androidplatform.net/ 载入（App 自己供文件）：
 * 算"安全网页"，陀螺仪（体感鼠标）才能用。
 */
class MainActivity : Activity(), BtLink.Listener, HidMouse.Listener {
    private lateinit var web: WebView
    private val link = BtLink(this)
    private val hid by lazy { HidMouse(this, this) }
    private val prefs by lazy { getSharedPreferences("remote", MODE_PRIVATE) }
    /** 发出去还没回应的请求编号：断线时统一告诉网页失败了 */
    private val pending: MutableSet<Int> = ConcurrentHashMap.newKeySet()
    /** 传文件用的编号，和网页自己的编号错开 */
    private val uploadSeq = AtomicInteger(1_000_000_000)

    companion object {
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val REQ_PERM = 1
        private const val REQ_FILES = 2
        private const val REQ_DISCOVER = 3
        private const val REQ_ADVERTISE = 4
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 打音游、用体感鼠标时屏幕别自己黑掉
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this).apply {
            setBackgroundColor(0xff0e0e12.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                    if (req.url.host != ASSET_HOST) return null
                    val path = req.url.path?.trimStart('/') ?: return null
                    return try {
                        WebResourceResponse(if (path.endsWith(".html")) "text/html" else "application/octet-stream", "utf-8", assets.open(path))
                    } catch (e: IOException) {
                        null
                    }
                }
            }
            addJavascriptInterface(Bridge(), "BT")
        }
        setContentView(web)
        registerReceiver(bondReceiver, android.content.IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED))
        web.loadUrl("https://$ASSET_HOST/index.html")
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), REQ_PERM)
        } else {
            connectSaved()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_ADVERTISE) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) discoverable()
            return
        }
        if (requestCode != REQ_PERM) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) connectSaved()
        else onStatus("没有蓝牙权限：到系统设置里给「桌面遥控」打开「附近的设备」", false)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun onDestroy() {
        // App 关了就不再当鼠标
        runCatching { unregisterReceiver(bondReceiver) }
        hid.stop()
        link.stop()
        web.destroy()
        super.onDestroy()
    }

    /** 全屏：藏起状态栏和导航栏（从边上划一下会临时出来） */
    @Suppress("DEPRECATION")
    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    // ---------------- 选电脑、连接 ----------------

    @SuppressLint("MissingPermission")
    private fun bonded(): List<BluetoothDevice>? {
        val adapter = (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter ?: return null
        if (!adapter.isEnabled) return null
        return adapter.bondedDevices.toList()
    }

    private fun connectSaved() {
        val list = bonded()
        if (list == null) {
            onStatus("蓝牙关着：先打开手机蓝牙，再点右上角重新连接", false)
            return
        }
        val dev = list.find { it.address == prefs.getString("pc", null) }
        if (prefs.getBoolean("hid", false)) hid.start(dev)
        if (dev == null) choosePc() else link.start(dev)
    }

    /** 现在选的那台电脑 */
    @SuppressLint("MissingPermission")
    private fun savedPc(): BluetoothDevice? = bonded()?.find { it.address == prefs.getString("pc", null) }

    override fun onHidHost(device: BluetoothDevice) = usePc(device)

    /** 记成"我的电脑"（还没选过的话），普通蓝牙那条线也连上 */
    private fun usePc(device: BluetoothDevice) {
        if (prefs.getString("pc", null) == device.address) return
        prefs.edit().putString("pc", device.address).apply()
        link.start(device)
    }

    // 配对完成：电脑刚和手机配好对，顺便记成"我的电脑"、作为鼠标连过去
    private val bondReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context, i: Intent) {
            val d: BluetoothDevice = (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                else @Suppress("DEPRECATION") i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)) ?: return
            if (i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1) != BluetoothDevice.BOND_BONDED) return
            if (!prefs.getBoolean("hid", false) && prefs.getString("pc", null) != null) return
            usePc(d)
            hid.paired(d)
        }
    }

    override fun onHidState(text: String, ready: Boolean) {
        js("window.__bt&&__bt.hid&&__bt.hid(${JSONObject.quote(text)},$ready)")
    }

    @SuppressLint("MissingPermission")
    private fun choosePc() {
        val list = bonded()
        if (list == null) {
            onStatus("蓝牙关着：先打开手机蓝牙", false)
            return
        }
        if (list.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("还没有配对的电脑")
                .setMessage("先到 设置 → 蓝牙 里把电脑配对好（电脑上也要点允许），再回来。")
                .setPositiveButton("去蓝牙设置") { _, _ -> startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        val names = list.map { (runCatching { it.name }.getOrNull() ?: "（没有名字）") + "\n" + it.address }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("选你的电脑")
            .setItems(names) { _, i ->
                prefs.edit().putString("pc", list[i].address).apply()
                link.start(list[i])
                if (prefs.getBoolean("hid", false)) hid.start(list[i])
            }
            .show()
    }

    @Suppress("DEPRECATION")
    private fun discoverable() {
        // 先确保已经在当鼠标（电脑配对时才看得到"鼠标"这个服务）
        prefs.edit().putBoolean("hid", true).apply()
        hid.start(savedPc())
        startActivityForResult(Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).putExtra(android.bluetooth.BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 120), REQ_DISCOVER)
    }

    // ---------------- 蓝牙 → 网页 ----------------

    private fun js(code: String) = web.post { web.evaluateJavascript(code, null) }

    override fun onStatus(text: String, connected: Boolean) {
        if (!connected) {
            // 断了：还在等回应的请求都算失败，网页别一直等
            val ids = pending.toList()
            pending.clear()
            for (id in ids) js("window.__bt&&__bt.fail($id,${JSONObject.quote("蓝牙断了")})")
        }
        js("window.__bt&&__bt.status(${JSONObject.quote(text)},$connected)")
    }

    override fun onFrame(head: JSONObject, body: ByteArray) {
        val id = head.optInt("id")
        pending.remove(id)
        val status = head.optInt("s", 500)
        val type = JSONObject.quote(head.optString("t", "text/plain"))
        js("window.__bt&&__bt.resp($id,$status,$type,${JSONObject.quote(String(body, Charsets.UTF_8))})")
    }

    // ---------------- 网页 → 蓝牙 ----------------

    inner class Bridge {
        @JavascriptInterface
        fun request(id: Int, method: String, url: String, body: String?) {
            val head = JSONObject().put("id", id).put("m", method).put("u", url)
            pending.add(id)
            if (!link.send(BtLink.frame(head, body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)))) {
                pending.remove(id)
                js("window.__bt&&__bt.fail($id,${JSONObject.quote("蓝牙没连上")})")
            }
        }

        /** 鼠标动作：当着蓝牙鼠标就变成 HID 报告发；不是的话走普通那条线（只发不等） */
        @JavascriptInterface
        fun mouse(json: String) {
            val ok = runCatching { hid.events(org.json.JSONArray(json)) }.getOrDefault(false)
            if (!ok) fire("POST", "/api/mouse", json)
        }

        /** 打开 / 关掉"手机当蓝牙鼠标" */
        @JavascriptInterface
        fun hidOn(on: Boolean) = runOnUiThread {
            prefs.edit().putBoolean("hid", on).apply()
            if (!on) return@runOnUiThread hid.stop()
            // 没选过电脑也先准备好当鼠标：电脑来配对时就能看到"鼠标"
            hid.start(savedPc())
        }

        /** 让电脑搜得到手机 2 分钟（电脑上重新配对时用） */
        @JavascriptInterface
        fun hidPair() = runOnUiThread {
            if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_ADVERTISE), REQ_ADVERTISE)
                return@runOnUiThread
            }
            discoverable()
        }

        /** 只发不等回应（鼠标移动、手柄状态）：一直发，不用等上一个回来 */
        @JavascriptInterface
        fun fire(method: String, url: String, body: String?) {
            val head = JSONObject().put("id", 0).put("m", method).put("u", url).put("nr", true)
            link.send(BtLink.frame(head, body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)))
        }

        @JavascriptInterface
        fun vibrate(ms: Int) {
            if (ms <= 0) return
            val v = getSystemService(VIBRATOR_SERVICE) as? Vibrator ?: return
            v.vibrate(VibrationEffect.createOneShot(ms.coerceIn(1, 500).toLong(), VibrationEffect.DEFAULT_AMPLITUDE))
        }

        /** 横屏（音游、游戏触控板）/ 放开（跟着手机转） */
        @JavascriptInterface
        fun setLandscape(on: Boolean) = runOnUiThread {
            requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }

        @JavascriptInterface
        fun pickUpload() = runOnUiThread {
            val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            @Suppress("DEPRECATION")
            startActivityForResult(i, REQ_FILES)
        }

        /** 换一台电脑 / 重新连接 */
        @JavascriptInterface
        fun choosePc() = runOnUiThread { this@MainActivity.choosePc() }

        @JavascriptInterface
        fun reconnect() = runOnUiThread { connectSaved() }
    }

    // ---------------- 传文件：自己读文件、分段发 ----------------

    @Deprecated("startActivityForResult 够用")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILES || resultCode != RESULT_OK || data == null) return
        val uris = mutableListOf<Uri>()
        data.clipData?.let { c -> for (i in 0 until c.itemCount) uris.add(c.getItemAt(i).uri) }
        if (uris.isEmpty()) data.data?.let { uris.add(it) }
        Thread({ for (u in uris) upload(u) }, "bt-upload").start()
    }

    private fun upload(uri: Uri) {
        var name = "手机文件"
        var size = -1L
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
            }
        }
        val id = uploadSeq.incrementAndGet()
        js("window.__bt&&__bt.upStart($id,${JSONObject.quote(name)})")
        pending.add(id)
        val url = "/api/upload?name=" + Uri.encode(name)
        fun failed(msg: String) {
            pending.remove(id)
            js("window.__bt&&__bt.fail($id,${JSONObject.quote(msg)})")
        }
        try {
            val inp = contentResolver.openInputStream(uri) ?: return failed("打不开这个文件")
            inp.use {
                val chunk = 32 * 1024
                fun next(): ByteArray? {
                    val b = ByteArray(chunk)
                    var n = 0
                    while (n < chunk) {
                        val r = it.read(b, n, chunk - n)
                        if (r < 0) break
                        n += r
                    }
                    return if (n == 0) null else b.copyOf(n)
                }
                var cur = next() ?: ByteArray(0)
                var sent = 0L
                var first = true
                var lastPct = -1
                while (true) {
                    val nxt = next()
                    val head = JSONObject().put("id", id)
                    if (first) head.put("m", "POST").put("u", url)
                    if (nxt != null) head.put("more", true)
                    if (!link.sendBulk(BtLink.frame(head, cur))) return failed("蓝牙断了")
                    first = false
                    sent += cur.size
                    if (size > 0) {
                        val pct = (sent * 100 / size).toInt().coerceAtMost(99)
                        if (pct != lastPct) {
                            lastPct = pct
                            js("window.__bt&&__bt.upProg($id,$pct)")
                        }
                    }
                    cur = nxt ?: break
                }
            }
        } catch (e: IOException) {
            failed("读文件出错：${e.message}")
        }
    }
}
