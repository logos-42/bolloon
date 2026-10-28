package com.bolloon.rokid.glass

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.view.View
import android.view.animation.DecelerateInterpolator

/**
 * 球体模式：中心球（bolloon）+ 四个卫星球（世界 / 外部 / 智能体 / 群组）。
 *
 * 视觉要求（leo 2026-10-28）：
 * - 五个球**同时显示**，球与球之间留大间距；
 * - **球之间不画连线/轨道线**（只有球本身）；
 * - 选中球变白填充并在切换时做一次缓慢的放大回弹（切换"慢一些"）。
 */
class SphereView(ctx: Context) : View(ctx) {

    var labels: List<String> = DEFAULT_LABELS
        set(v) { field = v; invalidate() }

    var selected: Int = 0
        set(v) {
            val changed = v != field
            field = v
            if (changed) pulse()
            invalidate()
        }

    private var scale = 1f
    private var animator: ValueAnimator? = null
    // 呼吸：持续的正弦相位（球径与相对位置都在缓慢动，像呼吸一样）
    private val breatheStart = SystemClock.uptimeMillis()
    private var breathing = false

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        color = Color.WHITE
    }
    private val rect = RectF()

    private fun pulse() {
        animator?.cancel()
        animator = ValueAnimator.ofFloat(1f, 1.14f, 1f).apply {
            duration = 420                       // 慢一点：一次切换给足 420ms
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                scale = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2f
        val cy = h / 2f
        val short = minOf(w, h)

        // 球之间留大间距（横向宽、纵向窄一点，才塞得进 480×380），球半径 0.145
        val rxBase = w * 0.355f
        val ryBase = h * 0.255f
        val rBase = short * 0.145f

        // 呼吸相位：周期 ~4.2s，每个球相位错开，于是"互相大小和相对位置"都在动
        val t = if (breathing) ((SystemClock.uptimeMillis() - breatheStart) % 4200L) / 4200f * (2 * Math.PI).toFloat() else 0f

        // 卫星球：上 / 右 / 下 / 左（不画任何连线）
        val angles = floatArrayOf(-90f, 0f, 90f, 180f)
        for (i in 0 until 4) {
            val ph = t + i * 1.15f
            val breath = 1f + 0.07f * kotlin.math.sin(ph)              // 球径呼吸 ±7%
            val orbitK = 1f + 0.045f * kotlin.math.sin(ph * 0.75f + 0.9f) // 相对位置呼吸 ±4.5%
            val rad = Math.toRadians(angles[i].toDouble())
            val bx = cx + (rxBase * orbitK * Math.cos(rad)).toFloat()
            val by = cy + (ryBase * orbitK * Math.sin(rad)).toFloat()
            drawBall(canvas, bx, by, rBase * breath, labels.getOrElse(i + 1) { "" }, selected == i + 1)
        }

        // 中心 bolloon 球（自己一个相位，呼吸节奏和卫星球错开）
        val centerBreath = 1f + 0.05f * kotlin.math.sin(t + 2.4f)
        drawBall(canvas, cx, cy, rBase * 1.18f * centerBreath, labels.getOrElse(0) { "bolloon" }, selected == 0)
        scheduleNextFrame()
    }

    private fun drawBall(canvas: Canvas, x: Float, y: Float, radius0: Float, label: String, active: Boolean) {
        val radius = if (active) radius0 * scale else radius0
        rect.set(x - radius, y - radius, x + radius, y + radius)
        if (active) {
            fill.color = Color.WHITE
            canvas.drawCircle(x, y, radius, fill)
            text.color = Color.BLACK
        } else {
            fill.color = Color.parseColor("#1C1C1C")
            canvas.drawCircle(x, y, radius, fill)
            stroke.color = Color.parseColor("#5A5A5A")
            canvas.drawCircle(x, y, radius, stroke)
            text.color = Color.parseColor("#DDDDDD")
        }
        text.textSize = if (label.length > 2) radius * 0.40f else radius * 0.58f
        val fm = text.fontMetrics
        canvas.drawText(label, x, y - (fm.ascent + fm.descent) / 2f, text)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        breathing = true
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        super.onDetachedFromWindow()
    }

    /** 30fps 自驱重绘（呼吸动画；不重绘时不会持续唤醒） */
    private fun scheduleNextFrame() {
        if (breathing && visibility == VISIBLE) postInvalidateDelayed(33)
    }

    companion object {
        val DEFAULT_LABELS = listOf("bolloon", "世界", "外部", "智能体", "群组")
    }
}
