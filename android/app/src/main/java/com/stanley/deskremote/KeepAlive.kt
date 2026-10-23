package com.stanley.deskremote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * 前台服务：通知栏挂一条"桌面遥控正在连着电脑"。
 * 安卓只让前台的 App 当蓝牙鼠标，App 一退到后台系统就把鼠标断掉；挂着前台服务，系统才当它"还在用"，
 * 切到别的 App、关屏幕，蓝牙鼠标和普通蓝牙都不会断。App 关掉时服务跟着停。
 */
class KeepAlive : Service() {
    companion object {
        private const val CHANNEL = "link"

        fun start(ctx: Context) {
            val i = Intent(ctx, KeepAlive::class.java)
            runCatching { ctx.startForegroundService(i) }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, KeepAlive::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "连着电脑", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("桌面遥控正在连着电脑")
            .setContentText("蓝牙鼠标和遥控在后台也保持连接；关掉 App 就断开")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(1, n)
        }
        return START_NOT_STICKY
    }
}
