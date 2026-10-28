package com.bolloon.rokid.glass

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import java.io.ByteArrayOutputStream

/**
 * 眼镜摄像头「扫一眼」：用 Camera2 拍一张 JPEG，交给节点做 OCR + 意图匹配。
 *
 * 为什么不用 Rokid SDK 的相机：Rokid 的 IMediaServer 在 com.rokid.security.system.server 里，
 * 这个包在消费版 Glasses 上没有；裸机开发本来就走标准 AOSP Camera2。
 */
class CameraCapture(private val ctx: Context) {

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    @Volatile private var done = false

    @SuppressLint("MissingPermission")
    fun capture(onJpeg: (ByteArray) -> Unit, onError: (String) -> Unit) {
        done = false
        val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = try {
            mgr.cameraIdList.firstOrNull {
                val f = mgr.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING)
                f == CameraCharacteristics.LENS_FACING_BACK
            } ?: mgr.cameraIdList.first()
        } catch (e: Exception) {
            return onError("没有可用摄像头: ${e.message}")
        }

        thread = HandlerThread("bolloon-cam").also { it.start() }
        handler = Handler(thread!!.looper)

        val sz = try {
            val map = mgr.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            map?.getOutputSizes(ImageFormat.JPEG)?.firstOrNull { it.width <= 1280 } ?: android.util.Size(640, 480)
        } catch (e: Exception) {
            android.util.Size(640, 480)
        }

        reader = ImageReader.newInstance(sz.width, sz.height, ImageFormat.JPEG, 1).apply {
            setOnImageAvailableListener({ r ->
                try {
                    val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
                    val buf = img.planes[0].buffer
                    val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                    img.close()
                    if (!done) {
                        done = true
                        onJpeg(bytes)
                    }
                } catch (e: Exception) {
                    onError("取图失败: ${e.message}")
                } finally {
                    close()
                }
            }, handler)
        }

        try {
            mgr.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(cam: CameraDevice) {
                    device = cam
                    cam.createCaptureSession(listOf(reader!!.surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            session = s
                            try {
                                val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                                    addTarget(reader!!.surface)
                                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                }.build()
                                s.capture(req, null, handler)
                            } catch (e: Exception) {
                                onError("拍照失败: ${e.message}")
                                close()
                            }
                        }

                        override fun onConfigureFailed(s: CameraCaptureSession) {
                            onError("相机会话配置失败")
                            close()
                        }
                    }, handler)
                }

                override fun onDisconnected(cam: CameraDevice) {
                    cam.close(); device = null
                }

                override fun onError(cam: CameraDevice, code: Int) {
                    onError("相机打开失败 code=$code")
                    cam.close(); device = null
                }
            }, handler)
        } catch (e: Exception) {
            onError("无法打开相机: ${e.message}")
            close()
        }
    }

    fun close() {
        try { session?.close() } catch (_: Exception) {}
        try { device?.close() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        session = null; device = null; reader = null
        thread?.quitSafely(); thread = null; handler = null
    }

    companion object {
        fun downscale(bytes: ByteArray, maxBytes: Int = 900_000): ByteArray {
            if (bytes.size <= maxBytes) return bytes
            val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = 2 }
            val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return bytes
            val out = ByteArrayOutputStream()
            bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
            bmp.recycle()
            return out.toByteArray()
        }
    }
}
