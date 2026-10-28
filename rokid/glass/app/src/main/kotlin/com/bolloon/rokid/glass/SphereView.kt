package com.bolloon.rokid.glass

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
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
        val rx = w * 0.355f
        val ry = h * 0.255f
        val r = short * 0.145f

        // 卫星球：上 / 右 / 下 / 左（不画任何连线）
        val angles = floatArrayOf(-90f, 0f, 90f, 180f)
        for (i in 0 until 4) {
            val rad = Math.toRadians(angles[i].toDouble())
            val bx = cx + (rx * Math.cos(rad)).toFloat()
            val by = cy + (ry * Math.sin(rad)).toFloat()
            drawBall(canvas, bx, by, r, labels.getOrElse(i + 1) { "" }, selected == i + 1)
        }

        // 中心 bolloon 球
        drawBall(canvas, cx, cy, r * 1.18f, labels.getOrElse(0) { "bolloon" }, selected == 0)
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

    override fun onDetachedFromWindow() {
        animator?.cancel()
        super.onDetachedFromWindow()
    }

    companion object {
        val DEFAULT_LABELS = listOf("bolloon", "世界", "外部", "智能体", "群组")
    }
}
