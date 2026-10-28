package com.bolloon.rokid.glass

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

/**
 * 眼镜麦克风录音 → 16kHz / 单声道 / 16bit WAV。
 *
 * 眼镜端没有系统 ASR（android.speech 的 RecognitionService 在本机不存在，
 * Rokid 的 AIUIService 是 signature 权限，第三方绑定不了），
 * 所以这里只负责"收声"，识别交给 bolloon 节点的 /api/asr。
 */
class VoiceRecorder {
    private val sampleRate = 16000
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var running = false

    val isRecording: Boolean get() = running

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        pcm.reset()
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val bufSize = maxOf(minBuf, sampleRate / 2 * 2) // 至少 0.5s 缓冲
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufSize,
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            error("麦克风初始化失败 (state=${rec.state})")
        }
        record = rec
        running = true
        rec.startRecording()
        thread = Thread {
            val buf = ByteArray(3200)
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) synchronized(pcm) { pcm.write(buf, 0, n) }
            }
        }.also { it.start() }
    }

    /** 停止录音并返回 WAV 字节（空录音返回 null） */
    fun stop(): ByteArray? {
        if (!running) return null
        running = false
        try {
            record?.stop()
        } catch (_: Exception) {
        }
        thread?.join(500)
        record?.release()
        record = null
        thread = null
        val data = synchronized(pcm) { pcm.toByteArray() }
        if (data.size < sampleRate / 2) return null // 不足 0.25s 直接丢
        // 静音门：环境噪声/没人说话时不要让 whisper 编出一句话（它会幻觉）
        var sum = 0.0
        var n = 0
        var i = 0
        while (i + 1 < data.size) {
            val s = ((data[i + 1].toInt() shl 8) or (data[i].toInt() and 0xFF)).toShort().toInt()
            sum += (s * s).toDouble()
            n++
            i += 2
        }
        val rms = if (n > 0) kotlin.math.sqrt(sum / n) else 0.0
        if (rms < 600.0) return null // 太安静 ⇒ 当作没说话
        return wav(data, sampleRate, 1, 16)
    }

    private fun wav(pcmData: ByteArray, rate: Int, channels: Int, bits: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val d = DataOutputStream(out)
        val byteRate = rate * channels * bits / 8
        d.writeBytes("RIFF")
        d.writeInt(Integer.reverseBytes(36 + pcmData.size))
        d.writeBytes("WAVE")
        d.writeBytes("fmt ")
        d.writeInt(Integer.reverseBytes(16))
        d.writeShort(java.lang.Short.reverseBytes(1.toShort()).toInt())
        d.writeShort(java.lang.Short.reverseBytes(channels.toShort()).toInt())
        d.writeInt(Integer.reverseBytes(rate))
        d.writeInt(Integer.reverseBytes(byteRate))
        d.writeShort(java.lang.Short.reverseBytes((channels * bits / 8).toShort()).toInt())
        d.writeShort(java.lang.Short.reverseBytes(bits.toShort()).toInt())
        d.writeBytes("data")
        d.writeInt(Integer.reverseBytes(pcmData.size))
        d.write(pcmData)
        d.flush()
        return out.toByteArray()
    }
}
