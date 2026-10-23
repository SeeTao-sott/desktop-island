package com.stanley.deskremote

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import org.json.JSONObject
import java.io.DataInputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 和电脑之间的蓝牙线（经典蓝牙 RFCOMM）。断了自己每 3 秒重连。
 *
 * 一帧 = [头长度 u32 小端][头 JSON][内容长度 u32 小端][内容]，和电脑那边 phone_bt.rs 一样。
 * 发送分两条队：普通请求（鼠标、状态……）优先；传文件的分段排在后面，而且最多排 8 段，
 * 读文件的线程会等着，不会把整个文件读进内存，也不会挡住鼠标。
 */
class BtLink(private val listener: Listener) {
    interface Listener {
        fun onStatus(text: String, connected: Boolean)
        fun onFrame(head: JSONObject, body: ByteArray)
    }

    companion object {
        /** 电脑上「桌面遥控」蓝牙服务的编号（和 phone_bt.rs 的 SERVICE_UUID 一样） */
        val SERVICE: UUID = UUID.fromString("7d2e9b14-5c3a-4f61-a8e0-3b9c6d1f2a47")

        fun frame(head: JSONObject, body: ByteArray): ByteArray {
            val h = head.toString().toByteArray(Charsets.UTF_8)
            val out = ByteArray(8 + h.size + body.size)
            putU32(out, 0, h.size)
            System.arraycopy(h, 0, out, 4, h.size)
            putU32(out, 4 + h.size, body.size)
            System.arraycopy(body, 0, out, 8 + h.size, body.size)
            return out
        }

        private fun putU32(b: ByteArray, at: Int, v: Int) {
            b[at] = v.toByte()
            b[at + 1] = (v shr 8).toByte()
            b[at + 2] = (v shr 16).toByte()
            b[at + 3] = (v shr 24).toByte()
        }
    }

    @Volatile var connected = false
        private set
    @Volatile private var stopped = false
    @Volatile private var device: BluetoothDevice? = null
    @Volatile private var socket: BluetoothSocket? = null
    private var worker: Thread? = null
    private val high = LinkedBlockingQueue<ByteArray>()
    private val low = LinkedBlockingQueue<ByteArray>(8)

    /** 连这台电脑（换电脑时先断开旧的） */
    @Synchronized
    fun start(dev: BluetoothDevice) {
        device = dev
        socket?.let { runCatching { it.close() } }
        if (worker?.isAlive == true) return
        stopped = false
        worker = Thread({ loop() }, "bt-link").apply { isDaemon = true; start() }
    }

    fun stop() {
        stopped = true
        socket?.let { runCatching { it.close() } }
    }

    /** 普通请求：马上排进去；没连上返回 false */
    fun send(frame: ByteArray): Boolean {
        if (!connected) return false
        high.offer(frame)
        return true
    }

    /** 传文件的一段：队满了就等；等的时候断了返回 false */
    fun sendBulk(frame: ByteArray): Boolean {
        while (connected) {
            if (low.offer(frame, 200, TimeUnit.MILLISECONDS)) return true
        }
        return false
    }

    @SuppressLint("MissingPermission")
    private fun loop() {
        while (!stopped) {
            val dev = device ?: return
            val name = runCatching { dev.name }.getOrNull() ?: dev.address
            listener.onStatus("正在连接 $name…", false)
            try {
                val s = dev.createRfcommSocketToServiceRecord(SERVICE)
                socket = s
                s.connect()
                high.clear()
                low.clear()
                connected = true
                listener.onStatus("蓝牙已连接", true)
                session(s)
            } catch (e: IOException) {
                // 连不上或者断了：下面统一处理
            } finally {
                connected = false
                socket?.let { runCatching { it.close() } }
                socket = null
            }
            if (stopped) return
            listener.onStatus("蓝牙断开，正在重连…（电脑上要打开「蓝牙遥控」）", false)
            try {
                Thread.sleep(3000)
            } catch (e: InterruptedException) {
                return
            }
        }
    }

    private fun session(s: BluetoothSocket) {
        val out = s.outputStream
        // 写：普通请求优先，没有了再发传文件的分段
        val writer = Thread({
            try {
                while (connected) {
                    val f = high.poll() ?: low.poll(10, TimeUnit.MILLISECONDS) ?: high.poll(10, TimeUnit.MILLISECONDS) ?: continue
                    out.write(f)
                    out.flush()
                }
            } catch (e: Exception) {
                connected = false
                runCatching { s.close() }
            }
        }, "bt-write").apply { isDaemon = true; start() }
        // 读：一帧一帧交给网页
        val inp = DataInputStream(s.inputStream)
        try {
            while (connected) {
                val hl = readU32(inp)
                val head = ByteArray(hl).also { inp.readFully(it) }
                val bl = readU32(inp)
                val body = ByteArray(bl).also { inp.readFully(it) }
                listener.onFrame(JSONObject(String(head, Charsets.UTF_8)), body)
            }
        } finally {
            connected = false
            writer.interrupt()
        }
    }

    private fun readU32(inp: DataInputStream): Int {
        val b = ByteArray(4)
        inp.readFully(b)
        return (b[0].toInt() and 0xff) or ((b[1].toInt() and 0xff) shl 8) or
            ((b[2].toInt() and 0xff) shl 16) or ((b[3].toInt() and 0xff) shl 24)
    }
}
