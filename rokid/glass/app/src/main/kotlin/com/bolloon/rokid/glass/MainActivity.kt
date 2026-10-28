package com.bolloon.rokid.glass

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/**
 * Bolloon 眼镜主页 — 480x380 / 无触屏，全靠触摸面板按键驱动。
 *
 * 触摸面板实测按键（ROKID,PSOC-TP-R → /dev/input/event3）：
 *   KEY_UP / KEY_DOWN / KEY_LEFT / KEY_RIGHT / KEY_ENTER / KEY_BACK
 *
 * 按键约定（画面上也印着）：
 *   上   = 上滑刷新（机会/联系人/消息都刷）
 *   下   = 切板块（机会 ↔ 联系人）
 *   左右 = 翻卡片 / 换联系人
 *   单击 = 机会页「扫一眼」（摄像头 → OCR → 匹配意图 → 刷卡片）
 *          联系人页进入对话；对话页开始/停止说话
 *   双击 = 对话页返回，首页退出
 */
class MainActivity : Activity() {

    private enum class Section(val key: String) {
        WORLD("world"),
        EXTERNAL("external"),
        AGENTS("agents"),
        GROUPS("groups"),
        SETTINGS("settings"),
    }
    private enum class Screen { HOME, CHAT, WIDGET }
    /** 球体模式（默认）/ 卡片模式：点 bolloon 球切换 */
    private enum class Mode { SPHERE, CARD }

    private var section = Section.WORLD
    private var screen = Screen.HOME
    private var mode = Mode.SPHERE
    private var sphereSel = 0
    /** zh | en（设置页可切；球体模式不出现设置球） */
    private var lang = "zh"
    private var phone: BolloonApi.Phone? = null
    private var llm: BolloonApi.Llm? = null
    private var loggedIn = false
    private var loginMsg = ""
    private var lastLangAt = 0L
    /** 桌面/CLI 对话流：眼镜端按 /api/turns 增量轮询成卡片传输流 */
    private var feedSeen = 0
    private val feed = ArrayList<Pair<String, String>>()
    private var index = 0

    private var opportunities: List<BolloonApi.Opportunity> = emptyList()
    private var contacts: List<BolloonApi.Agent> = emptyList()
    private var myAgents: List<BolloonApi.Agent> = emptyList()
    private var groups: List<BolloonApi.Group> = emptyList()
    private var wallet: BolloonApi.Wallet? = null
    private var tasks: List<BolloonApi.Task> = emptyList()
    private var messages: List<BolloonApi.Message> = emptyList()
    private var pendingAuth = 0
    private var statusLine = "连接节点中…"
    /** 桌面连接链路（HTTP/QUIC），与数据统计分开显示 */
    private var linkLine = "连接桌面节点…"
    private var shotLine = ""
    private var shotText = ""
    private var logoFocused = false
    private var newDrops = 0
    /** 最小化后常开的意图识别（视频时间连续识别） */
    private var intentLoopOn = false
    private var lastKeyAt = 0L
    /** 球体模式：球之外的字（品牌名/连接状态/提示）是否已熄灭 */
    private var textDimmed = false
    private var lastIntent = ""
    private var intentCount = 0
    private var lastTopTitle = ""

    private val recorder = VoiceRecorder()
    private val camera by lazy { CameraCapture(this) }
    private var chatTarget: BolloonApi.Agent? = null
    private var chatGroup: BolloonApi.Group? = null
    private val transcript = StringBuilder()

    // views
    private lateinit var sidebarItems: MutableList<TextView>
    private lateinit var sidebarBox: LinearLayout
    private val profiles = HashMap<String, BolloonApi.Profile>()
    private val profileLoading = HashSet<String>()
    private var sidebarLevel = 0        // 0 = 顶层四栏, 1 = 该栏的条目列表
    private var longPressFired = false
    private var longPressTask: Runnable? = null
    private val keyHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private lateinit var logo: TextView
    private lateinit var header: TextView
    private lateinit var action: TextView
    private lateinit var cardTitle: TextView
    private lateinit var cardBody: TextView
    private lateinit var hint: TextView
    private lateinit var splash: TextView
    private lateinit var sphere: SphereView
    private lateinit var sphereHint: TextView
    private lateinit var topBrand: TextView
    private lateinit var connStatus: TextView
    private lateinit var feedStrip: TextView
    private lateinit var mainCol: LinearLayout
    private lateinit var widgetBar: LinearLayout
    private lateinit var widgetTitle: TextView
    private lateinit var widgetBody: TextView

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** 多语言取词（界面框架文字全走 Strings 表；数据内容不翻译） */
    private fun T(key: String): String = Strings.t(lang, key)

    private fun secLabel(sec: Section): String = T(sec.key)

    private fun nextLang(): String {
        val all = Strings.LANGS
        val i = all.indexOf(lang)
        return all[(if (i < 0) 0 else i + 1) % all.size]
    }

    /** 球体模式只放 4 个业务栏，设置不进球 */
    private val sphereSections: List<Section>
        get() = listOf(Section.WORLD, Section.EXTERNAL, Section.AGENTS, Section.GROUPS)

    /** 球外文字熄灭门槛：默认 10 分钟（可用 intent extra dim_ms 覆盖，便于验收） */
    /** 验收/调试直达：am start ... --es section settings（QA 用，不影响正常流程） */
    private fun applyQaIntent(i: android.content.Intent?) {
        val want = i?.getStringExtra("section") ?: return
        android.util.Log.i("BolloonQA", "applyQaIntent want=$want")
        val hit = Section.values().firstOrNull { it.key.equals(want, true) } ?: return
        section = hit
        sidebarLevel = 1
        screen = Screen.HOME
        mode = Mode.CARD   // 设置只在卡片模式存在，跳转必须切模式，否则会被球体渲染吃掉
        if (::mainCol.isInitialized) render()
    }

    override fun onNewIntent(i: android.content.Intent) {
        super.onNewIntent(i)
        setIntent(i)
        applyQaIntent(i)
    }

    private fun dimMs(): Long {
        val prefs = getSharedPreferences("bolloon", MODE_PRIVATE)
        return prefs.getLong("dim_ms", 600_000L)
    }

    private fun loadLang() {
        val saved = getSharedPreferences("bolloon", MODE_PRIVATE).getString("lang", "zh") ?: "zh"
        lang = if (saved in Strings.LANGS) saved else "zh"
    }

    private fun saveLang() {
        getSharedPreferences("bolloon", MODE_PRIVATE).edit().putString("lang", lang).apply()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.systemUiVisibility = 5894
        setContentView(buildView())
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA), 1)
        }
        // 封面：先给 logo，再进主页
        loadLang()
        // am start -e dim_ms 8000 传的是 String extra，两种都认
        val dimArg = intent?.getStringExtra("dim_ms")?.toLongOrNull()
            ?: intent?.getLongExtra("dim_ms", 0L) ?: 0L
        applyQaIntent(intent)
        if (dimArg > 0) {
            getSharedPreferences("bolloon", MODE_PRIVATE).edit().putLong("dim_ms", dimArg).apply()
        }
        lastKeyAt = android.os.SystemClock.uptimeMillis()
        keyHandler.postDelayed(object : Runnable {
            override fun run() {
                if (mode == Mode.SPHERE && screen == Screen.HOME && !textDimmed &&
                    android.os.SystemClock.uptimeMillis() - lastKeyAt >= dimMs()
                ) {
                    textDimmed = true
                    render()
                }
                keyHandler.postDelayed(this, 5_000)
            }
        }, 5_000)
        statusLine = "连接桌面节点…"
        splash.visibility = TextView.VISIBLE
        render()
        refresh()
        // 启动即留一条决策记录：这也是"眼镜端 → 节点存档"通路的自检点
        Archive.record(
            this, Archive.KIND_JUDGMENT, "glass-app", null,
            JSONObject().put("decision", "app_open").put("mode", mode.name),
        )
        splash.postDelayed({ splash.visibility = TextView.GONE }, 900)
        // App 打开即连桌面（HTTP 探测；QUIC 端点若在会一并显示）
        Thread {
            val line = BolloonApi.probe()
            runOnUiThread { linkLine = line; render() }
        }.start()
        startFeedLoop()
        // 常驻轻刷新：屏幕上看到的余额/消息/卡片不会长期停在旧值
        val ticker = android.os.Handler(mainLooper)
        ticker.postDelayed(object : Runnable {
            override fun run() {
                if (screen == Screen.HOME && !logoFocused) refresh()
                ticker.postDelayed(this, 20_000)
            }
        }, 20_000)
    }

    override fun onDestroy() {
        recorder.stop()
        camera.close()
        super.onDestroy()
    }

    // ───────────────────────── 视图 ─────────────────────────

    private fun buildView(): android.widget.FrameLayout {
        val outer = android.widget.FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        mainCol = col
        // 1) 顶栏：logo + 状态
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(3), dp(6), dp(3))
        }
        logo = TextView(this).apply {
            text = "◉ Bolloon · 帛龙"
            textSize = 13f
            setTextColor(Color.parseColor("#E6FF00"))
            setTypeface(typeface, Typeface.BOLD)
        }
        header = TextView(this).apply {
            text = statusLine
            textSize = 9f
            setTextColor(Color.parseColor("#9AA0A6"))
            gravity = Gravity.END
            maxLines = 1
        }
        top.addView(logo, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        top.addView(header, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        col.addView(top, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(22)))

        // 2) 主体：侧栏 + 内容
        val body = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val sidebar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#111111"))
            setPadding(0, 0, 0, 0)
        }
        sidebarBox = sidebar
        body.addView(sidebar, LinearLayout.LayoutParams(dp(70), ViewGroup.LayoutParams.MATCH_PARENT))

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(4), dp(6), dp(2))
        }
        // 默认动作条（机会页 = 扫一眼）
        action = TextView(this).apply {
            text = "📷 扫一眼"
            textSize = 11f
            gravity = Gravity.CENTER
            setTextColor(Color.BLACK)
            setBackgroundColor(Color.WHITE)
            setPadding(dp(6), dp(3), dp(6), dp(3))
        }
        cardTitle = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 2
        }
        cardBody = TextView(this).apply {
            textSize = 10.5f
            setTextColor(Color.parseColor("#DDDDDD"))
            setPadding(0, dp(2), 0, 0)
            movementMethod = ScrollingMovementMethod()
        }
        val cardScroll = ScrollView(this).apply { addView(cardBody) }
        content.addView(action, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        content.addView(cardTitle, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        content.addView(cardScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        body.addView(content, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        col.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // 3) 底部提示
        hint = TextView(this).apply {
            textSize = 8.5f
            setTextColor(Color.parseColor("#888888"))
            setPadding(dp(8), dp(1), dp(6), dp(2))
            maxLines = 2
        }
        col.addView(hint, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        outer.addView(col)

        // 球体模式（默认）：中心 bolloon + 四周四个球
        sphere = SphereView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            visibility = TextView.GONE
        }
        outer.addView(sphere)
        topBrand = TextView(this).apply {
            text = "◉ Bolloon · 帛龙"
            textSize = 12f
            setTextColor(Color.parseColor("#E6FF00"))
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), dp(4), dp(10), dp(4))
            val lp = android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.gravity = Gravity.TOP or Gravity.START
            layoutParams = lp
            visibility = TextView.GONE
        }
        outer.addView(topBrand)
        connStatus = TextView(this).apply {
            textSize = 9f
            setTextColor(Color.parseColor("#8A8A8A"))
            setPadding(dp(6), dp(6), dp(8), dp(4))
            val lp = android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.gravity = Gravity.TOP or Gravity.END
            layoutParams = lp
            visibility = TextView.GONE
        }
        outer.addView(connStatus)
        feedStrip = TextView(this).apply {
            textSize = 9f
            setTextColor(Color.parseColor("#B8B8B8"))
            setBackgroundColor(Color.parseColor("#CC0A0A0A"))
            setPadding(dp(8), dp(3), dp(8), dp(3))
            maxLines = 2
            val lp = android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.gravity = Gravity.BOTTOM or Gravity.START
            lp.bottomMargin = dp(20)
            layoutParams = lp
            visibility = TextView.GONE
        }
        outer.addView(feedStrip)
        sphereHint = TextView(this).apply {
            textSize = 9f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#BBBBBB"))
            val lp = android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.gravity = Gravity.BOTTOM
            lp.bottomMargin = dp(4)
            layoutParams = lp
            visibility = TextView.GONE
        }
        outer.addView(sphereHint)

        // 左下角挂件（最小化态）：黑底不画 = 透视屏上只剩这一块
        widgetBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#101010"))
            setPadding(dp(8), dp(5), dp(8), dp(6))
            visibility = TextView.GONE
            val lp = android.widget.FrameLayout.LayoutParams(dp(196), ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.gravity = Gravity.BOTTOM or Gravity.START
            lp.leftMargin = dp(6)
            lp.bottomMargin = dp(6)
            layoutParams = lp
        }
        widgetTitle = TextView(this).apply {
            text = "◉ Bolloon 帛龙"
            textSize = 11f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
        }
        widgetBody = TextView(this).apply {
            text = "等待世界消息…"
            textSize = 10f
            setTextColor(Color.parseColor("#CCCCCC"))
            maxLines = 2
        }
        widgetBar.addView(widgetTitle)
        widgetBar.addView(widgetBody)
        outer.addView(widgetBar)

        splash = TextView(this).apply {
            text = "◉ Bolloon 帛龙"
            textSize = 26f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            setBackgroundColor(Color.BLACK)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        outer.addView(splash)

        outer.isFocusable = true
        outer.isFocusableInTouchMode = true
        outer.requestFocus()
        return outer
    }

    /** 卡片切换：从一侧滑入 12dp，慢一点、有过渡感 */
    private fun animateCard(dir: Int) {
        if (!::cardBody.isInitialized) return
        cardBody.translationX = dir * dp(14).toFloat()
        cardBody.animate().translationX(0f).setDuration(160).start()
    }

    private fun render() {
        logo.text = "◉ Bolloon · 帛龙"
        header.text = statusLine
        if (screen == Screen.WIDGET) { renderWidget(); return }
        if (mode == Mode.SPHERE && screen == Screen.HOME) { renderSphere(); return }
        sphere.visibility = TextView.GONE
        sphereHint.visibility = TextView.GONE
        topBrand.visibility = TextView.GONE
        if (::connStatus.isInitialized) connStatus.visibility = TextView.GONE
        mainCol.visibility = LinearLayout.VISIBLE
        if (screen == Screen.HOME) {
            renderSidebar()
            if (logoFocused) { renderCurrentSection(); applyHeaderFocus(); return }
            if (sidebarLevel == 0) renderSectionOverview() else renderCurrentSection()
            applyHeaderFocus()
        } else {
            sidebarItems.forEach { v ->
                v.setTextColor(Color.parseColor("#666666"))
                v.setBackgroundColor(Color.TRANSPARENT)
            }
            renderChat()
        }
    }

    private var lastNavStep = 0L

    /** 卡片/切栏节流：600ms 一次，避免"嗖"地连跳 */
    private fun navDebounce(): Boolean {
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastNavStep < 600) return false
        lastNavStep = now
        return true
    }

    private var lastSphereStep = 0L

    /** 球体模式节流：一次切换至少隔 300ms，连续滑动时不会"嗖"地跳过好几个球 */
    private fun sphereDebounce(): Boolean {
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastSphereStep < 300) return false
        lastSphereStep = now
        return true
    }

    /** 球体模式：五个球一起显示（bolloon 中心 + 四栏），选中球打白 */
    private fun renderSphere() {
        mainCol.visibility = LinearLayout.GONE
        sphere.visibility = TextView.VISIBLE
        sphereHint.visibility = TextView.VISIBLE
        topBrand.visibility = TextView.VISIBLE
        connStatus.visibility = TextView.VISIBLE
        connStatus.text = linkLine
        sphere.labels = listOf("Bolloon") + sphereSections.map { secLabel(it) }
        sphere.selected = sphereSel
        if (::connStatus.isInitialized) connStatus.text = linkLine
        // 10 分钟无操作 ⇒ 球之外的字全部熄灭，只剩球；任意按键点亮
        val textVis = if (textDimmed) TextView.GONE else TextView.VISIBLE
        if (::topBrand.isInitialized) topBrand.visibility = textVis
        if (::connStatus.isInitialized) connStatus.visibility = textVis
        if (::sphereHint.isInitialized) sphereHint.visibility = textVis
        sphereHint.text = if (sphereSel == 0)
            "◉ Bolloon 帛龙 · 单击:bolloon 球→卡片模式 · 长按:选中标签→单击最小化"
        else
            "${secLabel(sphereSections[sphereSel - 1])} · " + T("tap_confirm") + " · " + T("swipe_next")
    }

    private fun onSphereConfirm() {
        if (sphereSel == 0) {
            mode = Mode.CARD          // 点 bolloon 球 = 切卡片模式（当前页保留）
            logoFocused = false
        } else {
            section = sphereSections[sphereSel - 1]
            sidebarLevel = 1
            index = 0
            mode = Mode.CARD
        }
        render()
        refresh()
    }

    /**
     * 侧栏两级：顶层四栏 → 进入某栏后**侧栏内容被替换**成该栏的条目列表
     * （外部智能体列表 / 本地智能体列表 / 群组列表 / 世界卡片标题）。
     * 长按条目 = 固定 ping（智能体）。
     */
    private fun renderSidebar() {
        if (!::sidebarBox.isInitialized) return
        sidebarBox.removeAllViews()
        sidebarItems = mutableListOf()

        if (sidebarLevel == 0) {
            Section.values().forEachIndexed { i, s ->
                val tv = sidebarRow(secLabel(s), active = i == section.ordinal, small = false)
                tv.setOnClickListener { section = s; index = 0; sidebarLevel = 1; render(); refresh() }
                sidebarBox.addView(tv)
                sidebarItems.add(tv)
            }
            return
        }

        // 二级：标题行（点它回顶层）+ 条目
        val head = sidebarRow("‹ " + secLabel(section), active = false, small = true)
        head.setOnClickListener { sidebarLevel = 0; render() }
        sidebarBox.addView(head)

        val labels: List<String> = when (section) {
            Section.WORLD -> opportunities.map { it.title }
            Section.EXTERNAL -> contacts.map { it.name }
            Section.AGENTS -> myAgents.map { it.name }
            Section.GROUPS -> groups.map { it.name }
            Section.SETTINGS -> listOf(
                T("language") + " / " + (Strings.LANG_NAMES[lang] ?: lang),
                T("phone") + " / " + (phone?.let { if (it.bound) "…" + it.phone.takeLast(4) else T("not_bound") } ?: "…"),
                T("model") + " / " + (llm?.let { "${it.provider} · ${it.model}" } ?: "…"),
                T("link") + " / " + if (linkLine.contains("已连") || linkLine.contains("connected")) "✓" else "✗",
            )
        }
        if (labels.isEmpty()) {
            sidebarBox.addView(sidebarRow("（空）", active = false, small = true))
            return
        }
        labels.forEachIndexed { i, label ->
            val tv = sidebarRow(label, active = i == index, small = true)
            tv.setOnClickListener { index = i; render() }
            sidebarBox.addView(tv)
            sidebarItems.add(tv)
        }
    }

    private fun sidebarRow(label: String, active: Boolean, small: Boolean): TextView =
        TextView(this).apply {
            text = label
            textSize = if (small) 10f else 11.5f
            maxLines = 2
            gravity = Gravity.CENTER
            setPadding(dp(3), dp(8), dp(3), dp(8))
            setTextColor(if (active) Color.BLACK else Color.parseColor("#BBBBBB"))
            setBackgroundColor(if (active) Color.WHITE else Color.TRANSPARENT)
            isClickable = true
            isFocusable = false
        }

    /** 顶层：只给四栏的概览（条目在侧栏里） */
    private fun renderSectionOverview() {
        action.text = when (section) {
            Section.WORLD -> "📷 扫一眼 · 识别画面匹配意图"
            Section.EXTERNAL -> "🎤 外部智能体"
            Section.AGENTS -> "🎤 我的智能体"
            Section.GROUPS -> "💬 群组"
            Section.SETTINGS -> "⚙ " + T("settings")
        }
        cardTitle.text = when (section) {
            Section.WORLD -> T("world") + " · ${opportunities.size}"
            Section.EXTERNAL -> "外部智能体 · ${contacts.size}"
            Section.AGENTS -> "我的智能体 · ${myAgents.size}"
            Section.GROUPS -> "群组 · ${groups.size}"
            Section.SETTINGS -> T("settings")
        }
        cardBody.text = when (section) {
            Section.WORLD -> "往后滑进列表 → 侧栏换成卡片标题\n单击 = 扫一眼（摄像头 → OCR → 匹配意图 → 刷卡片）"
            Section.EXTERNAL -> "往后滑进列表 → 侧栏换成外部智能体名单\n长按条目 = 固定 ping"
            Section.AGENTS -> "往后滑进列表 → 侧栏换成我的智能体名单\n长按条目 = 固定 ping"
            Section.GROUPS -> "往后滑进列表 → 侧栏换成群组名单\n（本地群 + 含外部智能体的群）"
            Section.SETTINGS -> T("language") + " / " + T("phone") + " / " + T("bluetooth")
        }
        hint.text = "往后滑:进列表 · 单击:进列表 · 双击:退出"
    }

    private fun ensureSectionData() {
        if (section == Section.SETTINGS) {
            if (phone == null) refreshPhone()
            if (llm == null) refreshLlm()
        }
    }

    private fun renderCurrentSection() {
        ensureSectionData()
        when (section) {
            Section.WORLD -> renderOpportunities()
            Section.EXTERNAL -> renderContacts()
            Section.AGENTS -> renderMyAgents()
            Section.GROUPS -> renderGroups()
            Section.SETTINGS -> renderSettings()
        }
    }

    /** 顶部外壳（◉ bolloon 那一行）被选中时高亮；单击它 = 最小化成左下角挂件 */
    private fun applyHeaderFocus() {
        if (logoFocused) {
            logo.setBackgroundColor(Color.WHITE)
            logo.setTextColor(Color.BLACK)
            if (::topBrand.isInitialized) {
                topBrand.setBackgroundColor(Color.WHITE)
                topBrand.setTextColor(Color.BLACK)
            }
            hint.text = "标签已选中 · 单击:最小化到左下角 · 双击:球体/卡片互换"
        } else {
            logo.setBackgroundColor(Color.TRANSPARENT)
            logo.setTextColor(Color.parseColor("#E6FF00"))
            if (::topBrand.isInitialized) {
                topBrand.setBackgroundColor(Color.TRANSPARENT)
                topBrand.setTextColor(Color.parseColor("#E6FF00"))
            }
        }
    }

    private fun renderWidget() {
        // 最小化 = 只留左下角挂件：球体/顶栏/连接状态全部让位
        if (::sphere.isInitialized) sphere.visibility = TextView.GONE
        if (::sphereHint.isInitialized) sphereHint.visibility = TextView.GONE
        if (::topBrand.isInitialized) topBrand.visibility = TextView.GONE
        if (::connStatus.isInitialized) connStatus.visibility = TextView.GONE
        mainCol.visibility = LinearLayout.GONE
        widgetBar.visibility = TextView.VISIBLE
        val opp = opportunities.getOrNull(0)
        widgetTitle.text = "◉ Bolloon 帛龙" + if (newDrops > 0) "  +$newDrops" else ""
        widgetBody.text = when {
            lastIntent.isNotEmpty() -> "意图：$lastIntent" + if (intentCount > 1) " ×$intentCount" else ""
            opp != null -> opp.title
            else -> "观察中…（每 8s 识别一次）"
        }
    }

    private fun renderOpportunities() {
        action.text = if (shotLine.isEmpty()) "📷 扫一眼 · 识别画面匹配意图" else shotLine
        val opp = opportunities.getOrNull(index)
        if (opp == null) {
            cardTitle.text = "世界还没有卡片"
            cardBody.text = "单击 = 扫一眼让摄像头判断你要什么\n（往后滑继续，底部提示会变）"
        } else {
            cardTitle.text = opp.title
            val dots = (0 until opportunities.size).joinToString(" ") { if (it == index) "●" else "○" }
            cardBody.text = buildString {
                append(opp.summary.ifBlank { "(无摘要)" })
                append("\n\n匹配 ").append((opp.score * 100).toInt()).append("%")
                append("   ").append(index + 1).append("/").append(opportunities.size)
                append("\n").append(dots)
                if (shotText.isNotEmpty()) {
                    append("\n\n识别到：").append(shotText.replace("\n", " ").take(120))
                }
            }
        }
        hint.text = "往前滑:回上一条 · 往后滑:下一条 · 单击:扫一眼 · 双击:退出 · 顶部外壳可最小化"
    }

    private fun renderContacts() {
        if (wallet == null && !walletLoading) refreshWallet()
        action.text = "🎤 外部智能体（单击进入对话）"
        val agent = contacts.getOrNull(index)
        val w = wallet
        val walletLine = when {
            w == null -> "钱包 查询中…"
            !w.ok -> "钱包 ${w.address.ifBlank { "-" }} · 查询失败: ${w.error.take(30)}"
            else -> "钱包 ${w.address.take(6)}…${w.address.takeLast(4)} · ${w.network}\nUSDC ${"%.2f".format(w.usdc)}   ETH ${"%.4f".format(w.eth)}"
        }
        val payLine = if (pendingAuth > 0) "⚠ 待确认支付/授权 $pendingAuth 条（电脑 Web UI 里确认）" else "待确认支付 0"
        val recent = if (messages.isEmpty()) "（暂无交流记录）"
        else messages.take(5).joinToString("\n") { m ->
            "· " + (if (m.role == "user") "我" else m.role) + "：" + m.content.replace("\n", " ").take(42)
        }
        val jobLine = if (tasks.isEmpty()) "（当前没有待执行工作）"
        else tasks.take(3).joinToString("\n") { t ->
            "· " + t.capability.ifBlank { t.id.take(10) } + (if (t.claimed) " · 已领取" else " · 待领取")
        }

        cardTitle.text = agent?.name ?: "暂无外部智能体"
        cardBody.text = buildString {
            if (agent == null) append("还没有外部智能体。\n在电脑 Web UI 里搜索节点加好友，这里就会出现。")
            else {
                append("DID   ").append(shortDid(agent.id)).append("\n")
                append("soul  对方节点的 soul（未同步，仅显示本机可见信息）").append("\n")
                append("功能  外部智能体 · 可对话/请求协作")
            }
            append("\n\n").append(walletLine)
            append("\n").append(payLine)
            append("\n\n最近交流（最新 5 条 · 上滑刷新）\n").append(recent)
            append("\n\n执行工作 ").append(tasks.size).append("\n").append(jobLine)
        }
        hint.text = "往前滑:回上一条 · 往后滑:下一条 · 单击:说话 · 双击:退出"
    }

    /** 侧栏「智能体」= 我自己节点上的智能体（详情 = DID 缩写 + soul + 功能简介，各占一栏） */
    private fun renderMyAgents() {
        action.text = "🎤 我的智能体（单击进入对话）"
        val a = myAgents.getOrNull(index)
        cardTitle.text = a?.name ?: "还没有智能体"
        if (a == null) {
            cardBody.text = "本机节点还没有创建智能体。\n在电脑 Web UI 新建一个，这里就会出现。"
        } else {
            val p = profileOf(a)
            cardBody.text = buildString {
                append("DID   ").append(p?.didShort ?: shortDid(a.id)).append("\n")
                append("soul  ").append(oneLine(p?.soul, p?.soulSet, "未设置（按默认身份运行）")).append("\n")
                append("功能  ").append(oneLine(p?.agentDoc, p?.agentDocSet, "未设置（默认能力：对话/工具/记忆）"))
                append("\n\n单击开始说话，说完再单击发送。")
                append("\n共 ").append(myAgents.size).append(" 个（往后滑切换 · 长按固定 ping）")
            }
        }
        hint.text = "往后滑:下一条 · 往前滑:上一条 · 单击:对话 · 长按:固定 ping · 双击:返回"
    }

    /** 取档案（带缓存；没有就异步拉一次） */
    private fun profileOf(a: BolloonApi.Agent): BolloonApi.Profile? {
        profiles[a.id]?.let { return it }
        if (!profileLoading.contains(a.id)) {
            profileLoading.add(a.id)
            Thread {
                val p = BolloonApi.agentProfile(a.id)
                runOnUiThread {
                    profileLoading.remove(a.id)
                    if (p != null) {
                        profiles[a.id] = p
                        render()
                    }
                }
            }.start()
        }
        return null
    }

    /** 只占一栏：压成一行、超长省略 */
    private fun oneLine(text: String?, isSet: Boolean?, empty: String): String {
        val t = text?.trim().orEmpty().replace("\n", " ").replace(Regex("\\s+"), " ")
        return if ((isSet == true) && t.isNotEmpty()) t.take(28) + if (t.length > 28) "…" else "" else empty
    }

    /** did:pi:26SyT…5eww 这种缩写（节点侧也算好了，这里兜底） */
    private fun shortDid(s: String): String =
        if (s.length <= 18) s else s.take(12) + "…" + s.takeLast(4)

    /** 侧栏「群组」= 本地群 + 含外部智能体的群 */
    private fun renderGroups() {
        action.text = "💬 群组（本地群 + 含外部智能体的群）"
        val g = groups.getOrNull(index)
        cardTitle.text = g?.name ?: "还没有群组"
        if (g == null) {
            cardBody.text = "本机还没有群组。\n在电脑 Web UI 新建群组或接受邀请后，这里就会出现。"
        } else {
            val msgs = runCatching { BolloonApi.groupMessages(g.id, 5) }.getOrDefault(emptyList())
            cardBody.text = buildString {
                append("ID: ").append(g.id)
                if (g.acl.isNotEmpty()) append("   ACL: ").append(g.acl)
                append("\n\n最近消息\n")
                if (msgs.isEmpty()) append("（暂无消息）")
                else msgs.takeLast(5).forEach { m ->
                    append("· ").append(if (m.role.length > 12) m.role.take(8) + "…" else m.role)
                    append("：").append(m.content.replace("\n", " ").take(38)).append("\n")
                }
                append("\n共 ").append(groups.size).append(" 个群（往后滑切换）")
            }
        }
        hint.text = "往前滑:回上一条 · 往后滑:下一条 · 单击:进群说话 · 双击:退出"
    }

    private fun openGroupChat(group: BolloonApi.Group) {
        Archive.record(
            this, Archive.KIND_JUDGMENT, "glass-group", null,
            JSONObject().put("decision", "open_group").put("group", group.name).put("acl", group.acl),
        )
        chatGroup = group
        chatTarget = null
        screen = Screen.CHAT
        transcript.setLength(0)
        transcript.append("群「").append(group.name).append("」\n\n")
        render()
        Thread {
            val msgs = runCatching { BolloonApi.groupMessages(group.id, 6) }.getOrDefault(emptyList())
            runOnUiThread {
                if (msgs.isEmpty()) transcript.append("（群里还没有消息）\n\n")
                else msgs.forEach { m ->
                    transcript.append(if (m.role.length > 12) m.role.take(8) + "…" else m.role)
                        .append("：").append(m.content).append("\n")
                }
                transcript.append("\n")
                render()
            }
        }.start()
    }

    private fun renderSettings() {
        action.text = "⚙ " + T("tap_lang")
        cardTitle.text = T("settings")
        val ph = phone
        val phoneLine = when {
            ph == null -> "…"
            !ph.bound -> T("not_bound")
            else -> {
                val p = ph.phone
                val masked = if (p.length >= 7) p.take(3) + "****" + p.takeLast(4) else p
                masked + if (ph.identityMatch) " · ✓" else " · ✗"
            }
        }
        cardBody.text = buildString {
            append(T("language")).append("   ").append(Strings.LANG_NAMES[lang] ?: lang).append("\n")
            append(T("phone")).append("   ").append(phoneLine).append("\n")
            append(T("bluetooth")).append("   ").append(T("bt_from_phone")).append("\n")
            append(T("link")).append("   ").append(linkLine).append("\n")
            append(T("data")).append("   ").append(statusLine).append("\n")
            append(T("model")).append("   ")
                .append(llm?.let { "${it.provider} · ${it.model}" + if (it.keyOk) " ✓" else " ✗" } ?: "…")
                .append("  (").append(T("sync_same")).append(")\n")
            if (loginMsg.isNotEmpty()) append(loginMsg).append("\n")
            append(T("version")).append("   0.1.0")
            append("\n\n").append(T("tap_lang"))
        }
        hint.text = T("tap_lang") + " · " + T("swipe_next") + " · " + T("dbl_exit")
    }

    /** 桌面/CLI 输入 + AI 回复 → 眼镜卡片传输流（3s 增量） */
    private fun startFeedLoop() {
        Thread {
            while (true) {
                try {
                    val (total, newTurns) = BolloonApi.turns(feedSeen)
                    if (newTurns.isNotEmpty()) {
                        synchronized(feed) {
                            feed.addAll(newTurns)
                            while (feed.size > 30) feed.removeAt(0)
                        }
                        feedSeen = total
                        runOnUiThread { renderFeed() }
                    } else if (total != 0 && feedSeen == 0) {
                        feedSeen = total   // 首次不把历史全灌进来
                    }
                } catch (_: Exception) {
                }
                try {
                    Thread.sleep(3_000)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }.start()
    }

    private fun renderFeed() {
        if (!::feedStrip.isInitialized) return
        val last = synchronized(feed) { feed.takeLast(2) }
        if (last.isEmpty()) {
            feedStrip.visibility = TextView.GONE
            return
        }
        feedStrip.visibility = TextView.VISIBLE
        feedStrip.text = last.joinToString("\n") { (role, text) ->
            val who = if (role == "user") (if (lang == "zh") "你" else "you") else "AI"
            who + ": " + text.replace("\n", " ").take(46)
        }
        if (screen == Screen.WIDGET) renderWidget()
    }

    private fun doLogin() {
        loginMsg = "…"
        render()
        Thread {
            val (ok, reason) = BolloonApi.login()
            runOnUiThread {
                loggedIn = ok
                loginMsg = if (ok) T("logged_in") else T("login_fail") + " · " + reason
                render()
            }
        }.start()
    }

    private fun refreshLlm() {
        Thread {
            val m = BolloonApi.models()
            runOnUiThread { llm = m; render() }
        }.start()
    }

    private fun refreshLink() {
        linkLine = "…"
        Thread {
            val line = BolloonApi.probe()
            runOnUiThread { linkLine = line; render() }
        }.start()
    }

    private fun refreshPhone() {
        Thread {
            val p = BolloonApi.phone()
            runOnUiThread { phone = p; if (section == Section.SETTINGS) render() }
        }.start()
    }

    private fun renderChat() {
        val isGroup = chatGroup != null
        val name = chatGroup?.name ?: chatTarget?.name ?: return
        action.text = if (recorder.isRecording) "● 正在听… 再次单击发送" else "🎤 单击说话"
        cardTitle.text = if (isGroup) "群 · $name" else name
        cardBody.text = transcript.toString().ifBlank { "单击开始说话，说完再单击一次发送。\n（识别在节点侧完成，不在眼镜上）" }
        (cardBody.parent as? ScrollView)?.post { (cardBody.parent as ScrollView).fullScroll(ScrollView.FOCUS_DOWN) }
        hint.text = "单击:说话/发送 · 往前滑/往后滑:翻记录 · 双击:返回"
    }

    // ───────────────────────── 按键 ─────────────────────────

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            lastKeyAt = android.os.SystemClock.uptimeMillis()
            if (textDimmed) {
                textDimmed = false
                render()
            }
        }
        val code = event.keyCode
        val isEnter = code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_DPAD_CENTER
        // 球体模式：五个球之间切换，单击进球（bolloon 球 = 切卡片模式）
        if (mode == Mode.SPHERE && screen == Screen.HOME) {
            if (isEnter) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    if (event.repeatCount == 0) {
                        longPressFired = false
                        val r = Runnable { longPressFired = true; onLongPress() }
                        longPressTask = r
                        keyHandler.postDelayed(r, 700)
                    }
                } else if (event.action == KeyEvent.ACTION_UP) {
                    longPressTask?.let { keyHandler.removeCallbacks(it) }
                    if (!longPressFired) {
                        if (logoFocused) enterWidget() else onSphereConfirm()
                    }
                }
                return true
            }
            if (event.action == KeyEvent.ACTION_DOWN) {
                when (code) {
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_LEFT -> {
                        if (sphereDebounce()) { sphereSel = (sphereSel + 4) % 5; renderSphere() }
                        return true
                    }
                    KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                        if (sphereDebounce()) { sphereSel = (sphereSel + 1) % 5; renderSphere() }
                        return true
                    }
                    KeyEvent.KEYCODE_BACK -> { finish(); return true }
                }
            }
            return super.dispatchKeyEvent(event)
        }
        if (isEnter) {
            when (event.action) {
                KeyEvent.ACTION_DOWN -> {
                    if (event.repeatCount == 0) {
                        longPressFired = false
                        val r = Runnable { longPressFired = true; onLongPress() }
                        longPressTask = r
                        keyHandler.postDelayed(r, 700)
                    }
                    return true
                }
                KeyEvent.ACTION_UP -> {
                    longPressTask?.let { keyHandler.removeCallbacks(it) }
                    if (!longPressFired) onConfirm()
                    return true
                }
            }
            return true
        }
        if (event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        when (code) {
            // 触摸面板的两种滑动：往前滑 = 往回走，往后滑 = 往下走
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_LEFT -> { onUp(); return true }
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT -> { onDown(); return true }
            KeyEvent.KEYCODE_BACK -> { onBack(); return true }
        }
        return super.dispatchKeyEvent(event)
    }

    /** 长按：选中左上角标签（选中后单击=最小化）；列表条目=固定 ping */
    private fun onLongPress() {
        if (screen == Screen.HOME) {
            if (sidebarLevel == 1 && !logoFocused) {
                when (section) {
                    Section.AGENTS -> myAgents.getOrNull(index)?.let { fixedPing(it); return }
                    Section.EXTERNAL -> contacts.getOrNull(index)?.let { fixedPing(it); return }
                    else -> {}
                }
            }
            logoFocused = true
            render()
            return
        }
        if (screen != Screen.HOME) {
            hint.text = "长按：首页选中左上角标签 → 单击最小化"
            return
        }
        when (section) {
            Section.AGENTS -> myAgents.getOrNull(index)?.let { fixedPing(it) }
            Section.EXTERNAL -> contacts.getOrNull(index)?.let { fixedPing(it) }
            else -> hint.text = "这一栏没有固定 ping"
        }
    }

    private fun fixedPing(agent: BolloonApi.Agent) {
        hint.text = "正在给 ${agent.name} 设固定 ping…"
        Thread {
            val ok = BolloonApi.setPing(agent.id, 90)
            runOnUiThread {
                hint.text = if (ok) "已固定 ping：${agent.name} · 90s"
                else "固定 ping 失败：${agent.name}"
            }
        }.start()
    }

    /** 往回走（往前滑）：条目往上一条；到顶则选中顶部外壳；首栏再退 = 上一栏 */
    private fun onUp() {
        when (screen) {
            Screen.CHAT -> {
                (cardBody.parent as? ScrollView)?.scrollBy(0, -dp(36))
            }
            Screen.WIDGET -> exitWidget()
            Screen.HOME -> {
                if (logoFocused) { refresh(); return }
                if (sidebarLevel == 1) {
                    if (index > 0) {
                        if (navDebounce()) { index -= 1; animateCard(-1); render() }
                        return
                    }
                    if (navDebounce()) { sidebarLevel = 0; render() }
                    return
                }
                val values = Section.values()
                if (section.ordinal == 0) {
                    logoFocused = true
                    render()
                    refresh()
                } else {
                    section = values[section.ordinal - 1]
                    layout_placeholder@ run {
                        index = 0
                    }
                    render()
                    refresh()
                }
            }
        }
    }

    private fun enterWidget() {
        logoFocused = false
        screen = Screen.WIDGET
        mainCol.visibility = LinearLayout.GONE
        widgetBar.visibility = TextView.VISIBLE
        newDrops = 0
        render()
        startWidgetPoll()
        startIntentLoop()
    }

    private fun exitWidget() {
        intentLoopOn = false
        screen = Screen.HOME
        widgetBar.visibility = TextView.GONE
        if (mode == Mode.SPHERE) {
            if (::sphere.isInitialized) sphere.visibility = TextView.VISIBLE
        } else {
            mainCol.visibility = LinearLayout.VISIBLE
        }
        mainCol.visibility = LinearLayout.VISIBLE
        newDrops = 0
        render()
    }

    private var widgetPolling = false

    /** 最小化后持续拉世界卡片：只保留一个新消息位置，新消息流入 */
    private fun startWidgetPoll() {
        if (widgetPolling) return
        widgetPolling = true
        Thread {
            while (screen == Screen.WIDGET) {
                runCatching {
                    val opps = BolloonApi.opportunities(4)
                    runOnUiThread {
                        if (opps.isNotEmpty()) {
                            val top = opps.first().title
                            if (lastTopTitle.isNotEmpty() && top != lastTopTitle) newDrops += 1
                            lastTopTitle = top
                            opportunities = opps
                            renderWidget()
                        }
                    }
                }
                try {
                    Thread.sleep(5000)
                } catch (_: InterruptedException) {
                    break
                }
            }
            widgetPolling = false
        }.start()
    }

    /**
     * 最小化后常开的意图识别：每 8s 拍一帧 → OCR + AI 预测意图 → 落 OrbitDB(intent-stream)。
     * 意图不进本地日志就够了吗？不够 —— leo 要的是给群聊内部智能体当输入，所以必须上报节点。
     */
    private fun startIntentLoop() {
        if (intentLoopOn) return
        intentLoopOn = true
        Thread {
            while (intentLoopOn && screen == Screen.WIDGET) {
                try {
                    camera.capture(
                        onJpeg = { jpeg ->
                            Thread {
                                try {
                                    val small = CameraCapture.downscale(jpeg)
                                    val j = BolloonApi.vision(small)
                                    val ok = j.optBoolean("ok", false)
                                    val intent = if (j.isNull("intent")) "" else j.optString("intent", "")
                                    val conf = j.optDouble("confidence", 0.0)
                                    val reason = j.optString("reason", "")
                                    val text = j.optString("text", "")
                                    if (ok && intent.isNotEmpty() && !intentLoopOn.not()) {
                                        BolloonApi.observeIntent(intent, conf, reason, text)
                                    }
                                    if (ok && intent.isNotEmpty()) {
                                        // 同一意图连续多次只计数，不重复刷屏
                                        runOnUiThread {
                                            if (intent == lastIntent) intentCount += 1 else {
                                                lastIntent = intent
                                                intentCount = 1
                                            }
                                            renderWidget()
                                        }
                                    }
                                } catch (_: Exception) {
                                }
                            }.start()
                        },
                        onError = { _ -> },
                    )
                } catch (_: Exception) {
                }
                try {
                    Thread.sleep(8_000)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }.start()
    }

    private fun refreshWidgetNow() {
        Thread {
            val opps = runCatching { BolloonApi.opportunities(4) }.getOrDefault(emptyList())
            runOnUiThread {
                if (opps.isNotEmpty()) {
                    val top = opps.first().title
                    if (lastTopTitle.isNotEmpty() && top != lastTopTitle) newDrops += 1
                    lastTopTitle = top
                    opportunities = opps
                }
                renderWidget()
            }
        }.start()
    }

    /** 往下走（往后滑）：条目往下一条；到底则进下一栏 */
    private fun onDown() {
        when (screen) {
            Screen.WIDGET -> exitWidget()
            Screen.CHAT -> {
                (cardBody.parent as? ScrollView)?.scrollBy(0, dp(36))
            }
            Screen.HOME -> {
                if (logoFocused) {
                    logoFocused = false
                    index = 0
                    render()
                    return
                }
                if (sidebarLevel == 0) {
                    // 顶层：往后滑 = 下一栏（进栏在单击里）
                    if (!navDebounce()) return
                    val values = Section.values()
                    section = values[(section.ordinal + 1) % values.size]
                    index = 0
                    render()
                    refresh()
                    return
                }
                val size = currentListSize()
                if (index + 1 < size) {
                    if (navDebounce()) { index += 1; animateCard(1); render() }
                    return
                }
                val values = Section.values()
                section = values[(section.ordinal + 1) % values.size]
                index = 0
                render()
                refresh()
            }
        }
    }

    private fun currentListSize(): Int = when (section) {
        Section.WORLD -> opportunities.size
        Section.EXTERNAL -> maxOf(contacts.size, 1)
        Section.AGENTS -> maxOf(myAgents.size, 1)
        Section.GROUPS -> maxOf(groups.size, 1)
        Section.SETTINGS -> 4
    }

    private fun onConfirm() {
        when (screen) {
            Screen.HOME -> {
                if (logoFocused) {
                    // 长按选中了左上角标签 → 单击 = 最小化
                    enterWidget()
                    return
                }
                if (sidebarLevel == 0) {
                    sidebarLevel = 1
                    index = 0
                    render()
                    refresh()
                    return
                }
                when (section) {
                    Section.WORLD -> shootAndMatch()
                    Section.EXTERNAL -> contacts.getOrNull(index)?.let { openChat(it) } ?: refresh()
                    Section.AGENTS -> myAgents.getOrNull(index)?.let { openChat(it) } ?: refresh()
                    Section.GROUPS -> groups.getOrNull(index)?.let { openGroupChat(it) } ?: refresh()
                    Section.SETTINGS -> when (index) {
                        // 语言：900ms 才允许再切，别一路刷过 7 语
                        0 -> {
                            val now = android.os.SystemClock.uptimeMillis()
                            if (now - lastLangAt > 900) {
                                lastLangAt = now
                                lang = nextLang()
                                saveLang()
                                render()
                            }
                        }
                        // 手机号：真登录（节点 DID 签名 + 验签）
                        1 -> doLogin()
                        // 模型：刷新（看是否与桌面/CLI 同步）
                        2 -> refreshLlm()
                        // 链接：重探
                        3 -> refreshLink()
                        else -> render()
                    }
                }
            }
            Screen.CHAT -> toggleTalk()
            Screen.WIDGET -> exitWidget()
        }
    }

    private fun onBack() {
        if (screen == Screen.WIDGET) {
            exitWidget()
            return
        }
        if (screen == Screen.HOME && logoFocused) {
            // 标签选中态双击 = 球体/卡片互换
            logoFocused = false
            mode = if (mode == Mode.SPHERE) Mode.CARD else Mode.SPHERE
            sphereSel = 0
            render()
            return
        }
        if (screen == Screen.CHAT) {
            screen = Screen.HOME
            chatTarget = null
            chatGroup = null
            render()
        } else {
            finish()
        }
    }

    // ───────────────────────── 扫一眼 ─────────────────────────

    private fun shootAndMatch() {
        shotLine = "📷 拍照中…"
        render()
        camera.capture(
            onJpeg = { jpeg ->
                runOnUiThread {
                    shotLine = "🧠 识别中…"
                    render()
                }
                Thread {
                    try {
                        val small = CameraCapture.downscale(jpeg)
                        val j = BolloonApi.vision(small)
                        val ok = j.optBoolean("ok", false)
                        val text = j.optString("text", "")
                        val intent = if (j.isNull("intent")) "" else j.optString("intent", "")
                        val hintText = j.optString("hint", j.optString("error", ""))
                        runOnUiThread {
                            shotLine = if (!ok) "⚠ ${hintText.take(40)}"
                            else if (intent.isNotEmpty()) "✓ 意图「$intent」"
                            else "✓ 已识别画面（未匹配意图）"
                            shotText = if (ok && text.isNotEmpty()) text else ""
                            render()
                        }
                        // 意图变了 → 重新拉机会卡片
                        val opps = runCatching { BolloonApi.opportunities() }.getOrDefault(emptyList())
                        runOnUiThread {
                            opportunities = opps
                            index = 0
                            if (ok && text.isNotEmpty()) {
                                cardBody.text = "识别到的画面文字：\n" + text.take(180)
                            }
                            hint.text = if (intent.isNotEmpty())
                                "已按意图「$intent」刷新 $opps.size 张机会卡片"
                            else
                                "已刷新 $opps.size 张机会卡片（左右翻看）"
                            render()
                        }
                    } catch (e: Exception) {
                        runOnUiThread {
                            shotLine = "⚠ 识别失败：${e.message ?: e.javaClass.simpleName}"
                            render()
                        }
                    }
                }.start()
            },
            onError = { msg ->
                runOnUiThread {
                    shotLine = "⚠ $msg"
                    render()
                }
            },
        )
    }

    // ───────────────────────── 对话 ─────────────────────────

    private fun openChat(agent: BolloonApi.Agent) {
        if (agent.id.isNotEmpty()) {
            Archive.record(
                this, Archive.KIND_JUDGMENT, "glass-card", agent.id,
                JSONObject().put("decision", "open_agent").put("name", agent.name).put("did", agent.id),
            )
        }
        chatTarget = agent
        chatGroup = null
        screen = Screen.CHAT
        transcript.setLength(0)
        transcript.append("与 ").append(agent.name).append(" 对话\n\n")
        render()
        refreshMessagesOnly()
    }

    private fun toggleTalk() {
        if (chatTarget == null && chatGroup == null) return
        if (!recorder.isRecording) {
            try {
                recorder.start()
                render()
            } catch (e: Exception) {
                appendLine("录音失败：${e.message}")
            }
            return
        }
        val wav = recorder.stop()
        render()
        if (wav == null) {
            appendLine("(没录到声音)")
            return
        }
        appendLine("…识别中")
        Thread {
            try {
                val text = BolloonApi.asr(wav)
                if (text.isBlank()) {
                    runOnUiThread { appendLine("(没听清，再说一次)") }
                    return@Thread
                }
                runOnUiThread { appendLine("我：$text") }
                val group = chatGroup
                if (group != null) {
                    val ok = BolloonApi.groupSay(group.id, text)
                    runOnUiThread {
                        if (!ok) appendLine("（发到群失败）")
                    }
                    try { Thread.sleep(2500) } catch (_: InterruptedException) {}
                    val msgs = runCatching { BolloonApi.groupMessages(group.id, 4) }.getOrDefault(emptyList())
                    runOnUiThread {
                        msgs.forEach { m -> if (m.content != text) appendLine(m.role.take(12) + "：" + m.content) }
                    }
                    return@Thread
                }
                val agent = chatTarget ?: return@Thread
                val reply = BolloonApi.chat(text, agent.id)
                runOnUiThread {
                    appendLine("${agent.name}：$reply")
                    speak(reply)
                }
            } catch (e: Exception) {
                runOnUiThread { appendLine("失败：${e.message ?: e.javaClass.simpleName}") }
            }
        }.start()
    }

    private fun appendLine(line: String) {
        transcript.append(line).append("\n\n")
        render()
    }

    private fun speak(text: String) {
        try {
            val tts = android.speech.tts.TextToSpeech(this) { }
            tts.language = java.util.Locale.CHINA
            tts.speak(text.take(120), android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "bolloon")
        } catch (_: Exception) {
        }
    }

    // ───────────────────────── 数据 ─────────────────────────

    private var walletLoading = false

    /** 链上余额单独刷（慢，不能挡住主刷新） */
    private fun refreshWallet() {
        walletLoading = true
        Thread {
            val w = BolloonApi.wallet()
            runOnUiThread {
                wallet = w
                walletLoading = false
                render()
            }
        }.start()
    }

    private fun refresh() {
        Thread {
            val opps = runCatching { BolloonApi.opportunities() }
            val cs = runCatching { BolloonApi.agents() }
            val mine = runCatching { BolloonApi.myAgents() }
            val gs = runCatching { BolloonApi.groups() }
            // 钱包走链上 RPC，慢 —— 不塞进这次刷新，单独刷（否则整屏都跟着卡住）
            val ts = BolloonApi.tasks()
            val ms = BolloonApi.messages(5)
            val pa = BolloonApi.pendingAuth()
            runOnUiThread {
                opportunities = opps.getOrDefault(emptyList())
                contacts = cs.getOrDefault(emptyList())
                myAgents = mine.getOrDefault(emptyList())
                groups = gs.getOrDefault(emptyList())
                tasks = ts
                messages = ms
                pendingAuth = pa
                statusLine = if (opps.isSuccess || cs.isSuccess)
                    "${T("world")} ${opportunities.size} · ${T("external")} ${contacts.size} · " +
                        "${T("agents")} ${myAgents.size} · ${T("groups")} ${groups.size}"
                else "节点离线 · 检查 adb reverse 54188"
                if (index >= currentListSize()) index = 0
                render()
            }
        }.start()
    }

    private fun refreshMessagesOnly() {
        Thread {
            val ms = BolloonApi.messages(5)
            runOnUiThread {
                messages = ms
                if (screen == Screen.HOME) render()
                else if (ms.isNotEmpty()) {
                    transcript.append("— 上滑刷新：最近 ").append(ms.size).append(" 条 —\n\n")
                    render()
                }
            }
        }.start()
    }
}
