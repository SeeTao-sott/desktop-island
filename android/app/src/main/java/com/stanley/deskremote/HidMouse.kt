package com.stanley.deskremote

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppQosSettings
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothProfile
import android.content.Context
import java.util.concurrent.Executors

/**
 * 手机当一个真正的蓝牙鼠标（蓝牙 HID）：电脑看到的就是一只硬件鼠标，和买来的蓝牙鼠标一样顺。
 * 用的是安卓 9 以上系统自带的 HID 设备功能（有的厂商把它关了，那就用不了，只能走普通蓝牙那条线）。
 *
 * 两种报告：
 * - 1 号：相对移动（触控板、转动移动），5 个键（左 右 中 返回 前进）+ X/Y（16 位）+ 竖滚轮 + 横滚轮
 * - 2 号：绝对位置（体感鼠标「指哪打哪」），5 个键 + X/Y（0~32767 对应整个屏幕）
 */
@SuppressLint("MissingPermission")
class HidMouse(private val ctx: Context, private val listener: Listener) {
    interface Listener {
        /** ready = 已经作为鼠标连上电脑，可以发了 */
        fun onHidState(text: String, ready: Boolean)

        /** 有电脑把这只鼠标连上了（配对后电脑主动连过来时，App 顺便把它记成"我的电脑"） */
        fun onHidHost(device: BluetoothDevice)
    }

    companion object {
        private val DESCRIPTOR = byteArrayOf(
            // ---- 1 号：相对移动的鼠标 ----
            0x05, 0x01, 0x09, 0x02, 0xA1.toByte(), 0x01,
            0x85.toByte(), 0x01,
            0x09, 0x01, 0xA1.toByte(), 0x00,
            0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95.toByte(), 0x05, 0x75, 0x01, 0x81.toByte(), 0x02,
            0x95.toByte(), 0x01, 0x75, 0x03, 0x81.toByte(), 0x03,
            0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x16, 0x01, 0x80.toByte(), 0x26, 0xFF.toByte(), 0x7F, 0x75, 0x10, 0x95.toByte(), 0x02, 0x81.toByte(), 0x06,
            0x09, 0x38, 0x15, 0x81.toByte(), 0x25, 0x7F, 0x75, 0x08, 0x95.toByte(), 0x01, 0x81.toByte(), 0x06,
            0x05, 0x0C, 0x0A, 0x38, 0x02, 0x15, 0x81.toByte(), 0x25, 0x7F, 0x75, 0x08, 0x95.toByte(), 0x01, 0x81.toByte(), 0x06,
            0xC0.toByte(),
            0xC0.toByte(),
            // ---- 2 号：绝对位置的鼠标 ----
            0x05, 0x01, 0x09, 0x02, 0xA1.toByte(), 0x01,
            0x85.toByte(), 0x02,
            0x09, 0x01, 0xA1.toByte(), 0x00,
            0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95.toByte(), 0x05, 0x75, 0x01, 0x81.toByte(), 0x02,
            0x95.toByte(), 0x01, 0x75, 0x03, 0x81.toByte(), 0x03,
            0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x00, 0x26, 0xFF.toByte(), 0x7F, 0x75, 0x10, 0x95.toByte(), 0x02, 0x81.toByte(), 0x02,
            0xC0.toByte(),
            0xC0.toByte(),
        )
        private val BUTTON_BIT = mapOf("left" to 1, "right" to 2, "middle" to 4, "back" to 8, "forward" to 16)
    }

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private val exec = Executors.newSingleThreadExecutor()
    private var hid: BluetoothHidDevice? = null
    private var target: BluetoothDevice? = null
    @Volatile private var host: BluetoothDevice? = null
    @Volatile private var buttons = 0
    @Volatile private var wanted = false

    val ready get() = host != null

    @Volatile private var registered = false
    /** 这次打开 App 后连上过（断了就是意外断开，自己重连；没连上过才提示重新配对） */
    @Volatile private var everConnected = false
    private var watcher: Thread? = null

    /**
     * 断了自己修：电脑的蓝牙偶尔会自己重启（这台的网卡蓝牙二合一芯片），手机系统有时还会把"当鼠标"的登记撤掉。
     * 每 5 秒看一次：系统的 HID 服务没了就重新要，登记被撤了就重新登记，没连着就再连。
     */
    @Synchronized
    private fun watch() {
        if (watcher?.isAlive == true) return
        watcher = Thread({
            while (wanted) {
                try {
                    Thread.sleep(5000)
                } catch (e: InterruptedException) {
                    return@Thread
                }
                if (!wanted) break
                val pc = target
                val h = hid
                runCatching {
                    when {
                        h == null -> openProxy()
                        !registered -> register(h)
                        host == null && pc != null -> h.connect(pc)
                    }
                }
            }
        }, "hid-reconnect").apply { isDaemon = true; start() }
    }

    /** 开始当鼠标；pc = 要连的电脑（还没配对时可以是 null：先准备好，等电脑来配对） */
    fun start(pc: BluetoothDevice?) {
        if (pc != null) target = pc
        wanted = true
        watch()
        val h = hid
        if (h != null) {
            if (registered) target?.let { h.connect(it) } ?: waitingForPc()
            return
        }
        listener.onHidState("正在打开蓝牙鼠标…", false)
        openProxy()
    }

    /** 向系统要 HID 设备服务（要到了就登记成鼠标） */
    private fun openProxy() {
        val ok = adapter?.getProfileProxy(ctx, object : BluetoothProfile.ServiceListener {
            override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                val p = proxy as BluetoothHidDevice
                hid = p
                register(p)
            }

            override fun onServiceDisconnected(profile: Int) {
                hid = null
                host = null
                registered = false
                listener.onHidState(if (wanted) "手机蓝牙重启了，正在重新打开蓝牙鼠标…" else "蓝牙鼠标关了", false)
            }
        }, BluetoothProfile.HID_DEVICE) ?: false
        if (!ok) listener.onHidState("这台手机不支持当蓝牙鼠标", false)
    }

    private fun register(p: BluetoothHidDevice) {
        val sdp = BluetoothHidDeviceAppSdpSettings("桌面遥控", "手机触控板", "DeskRemote", BluetoothHidDevice.SUBCLASS1_MOUSE, DESCRIPTOR)
        val qos = BluetoothHidDeviceAppQosSettings(BluetoothHidDeviceAppQosSettings.SERVICE_BEST_EFFORT, 800, 9, 0, 11250, BluetoothHidDeviceAppQosSettings.MAX)
        if (!p.registerApp(sdp, null, qos, exec, callback)) {
            listener.onHidState("这台手机不让 App 当蓝牙鼠标（系统没开放这个功能）", false)
        }
    }

    fun stop() {
        wanted = false
        val h = hid ?: return
        host?.let { h.disconnect(it) }
        h.unregisterApp()
        adapter?.closeProfileProxy(BluetoothProfile.HID_DEVICE, h)
        hid = null
        host = null
        listener.onHidState("蓝牙鼠标关了", false)
    }

    private val callback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            this@HidMouse.registered = registered
            if (!registered) {
                host = null
                // 被系统撤掉了：后台每 5 秒会重新登记
                listener.onHidState(if (wanted) "蓝牙鼠标被系统关掉了，正在重新打开…" else "蓝牙鼠标关了", false)
                return
            }
            val pc = pluggedDevice ?: target
            if (pc == null) return waitingForPc()
            listener.onHidState("正在作为鼠标连电脑…", false)
            if (wanted) hid?.connect(pc)
        }

        override fun onConnectionStateChanged(device: BluetoothDevice, state: Int) {
            when (state) {
                BluetoothProfile.STATE_CONNECTED -> {
                    host = device
                    target = device
                    everConnected = true
                    buttons = 0
                    listener.onHidHost(device)
                    listener.onHidState("蓝牙鼠标已连上", true)
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    if (host == device) host = null
                    listener.onHidState(
                        when {
                            !wanted -> "蓝牙鼠标关了"
                            everConnected -> "蓝牙鼠标断了，正在重连…"
                            else -> "电脑没接受这只鼠标：在电脑上删掉这台手机、重新配对一次（配对时手机要开着这个页面）"
                        },
                        false,
                    )
                }
            }
        }

        override fun onGetReport(device: BluetoothDevice, type: Byte, id: Byte, bufferSize: Int) {
            hid?.replyReport(device, type, id, ByteArray(if (id.toInt() == 2) 5 else 7))
        }
    }

    private fun waitingForPc() =
        listener.onHidState("已经准备好当鼠标：在电脑「蓝牙和其他设备 → 添加设备」里配对这台手机", false)

    /** 刚和这台电脑配对好：作为鼠标连过去 */
    fun paired(pc: BluetoothDevice) {
        target = pc
        if (wanted && registered && host == null) {
            listener.onHidState("正在作为鼠标连电脑…", false)
            hid?.connect(pc)
        }
    }

    // ---------------- 发报告 ----------------

    private fun send(id: Int, data: ByteArray): Boolean {
        val h = hid ?: return false
        val d = host ?: return false
        return h.sendReport(d, id, data)
    }

    private fun rel(dx: Int, dy: Int, wheel: Int = 0, pan: Int = 0) {
        val x = dx.coerceIn(-32767, 32767)
        val y = dy.coerceIn(-32767, 32767)
        send(1, byteArrayOf(buttons.toByte(), x.toByte(), (x shr 8).toByte(), y.toByte(), (y shr 8).toByte(),
            wheel.coerceIn(-127, 127).toByte(), pan.coerceIn(-127, 127).toByte()))
    }

    /** 0~1 的屏幕位置 */
    private fun abs(fx: Double, fy: Double) {
        val x = (fx.coerceIn(0.0, 1.0) * 32767).toInt()
        val y = (fy.coerceIn(0.0, 1.0) * 32767).toInt()
        val b = byteArrayOf(buttons.toByte(), x.toByte(), (x shr 8).toByte(), y.toByte(), (y shr 8).toByte())
        System.arraycopy(b, 1, lastAbsXY, 0, 4)
        send(2, b)
    }

    // 滚轮：网页按 Windows 的单位发（120 = 一格），HID 里一格是 1：攒着凑够一格再发
    private var restWheel = 0
    private var restPan = 0
    private var lastAbs = false

    /**
     * 网页的鼠标动作（和发给电脑的 /api/mouse 一样的格式），按顺序变成 HID 报告。
     * 返回 false = 现在不是蓝牙鼠标，网页改走普通那条线。
     */
    fun events(list: org.json.JSONArray): Boolean {
        if (!ready) return false
        for (i in 0 until list.length()) {
            val e = list.getJSONObject(i)
            when (e.optString("t")) {
                "m" -> {
                    lastAbs = false
                    rel(e.optInt("x"), e.optInt("y"))
                }
                "a" -> {
                    lastAbs = true
                    abs(e.optDouble("x"), e.optDouble("y"))
                }
                "w" -> {
                    restWheel += e.optInt("y")
                    restPan += e.optInt("x")
                    val w = restWheel / 120
                    val p = restPan / 120
                    restWheel -= w * 120
                    restPan -= p * 120
                    if (w != 0 || p != 0) rel(0, 0, w, p)
                }
                "b" -> {
                    val bit = BUTTON_BIT[e.optString("b")] ?: continue
                    val press = { down: Boolean ->
                        buttons = if (down) buttons or bit else buttons and bit.inv()
                        // 按键跟着上一次用的那种报告发，不会把鼠标挪走
                        if (lastAbs) send(2, byteArrayOf(buttons.toByte(), 0, 0, 0, 0).also { absKeep(it) }) else rel(0, 0)
                    }
                    when (e.optString("a", "click")) {
                        "down" -> press(true)
                        "up" -> press(false)
                        else -> {
                            press(true)
                            press(false)
                        }
                    }
                }
            }
        }
        return true
    }

    // 绝对模式下只按键：位置用上一次的（不然会跳到左上角）
    private var lastAbsXY = byteArrayOf(0, 0, 0, 0)
    private fun absKeep(b: ByteArray) = System.arraycopy(lastAbsXY, 0, b, 1, 4)
}
