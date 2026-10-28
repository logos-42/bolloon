package com.bolloon.rokid.glass

/**
 * 眼镜端界面文案表（多语言）。
 *
 * 覆盖原则：**界面框架文字**全部走这张表；服务器返回的数据文本不翻译（那是内容不是 UI）。
 * 语言顺序与设置页保持一致：中文 → English → العربية → Português → Español → Français → Latina
 */
object Strings {
    val LANGS = listOf("zh", "en", "ar", "pt", "es", "fr", "la")

    /** 每种语言在设置页里的自称 */
    val LANG_NAMES = mapOf(
        "zh" to "中文",
        "en" to "English",
        "ar" to "العربية",
        "pt" to "Português",
        "es" to "Español",
        "fr" to "Français",
        "la" to "Latina",
    )

    private val table: Map<String, Map<String, String>> = mapOf(
        "world" to mapOf(
            "zh" to "世界", "en" to "World", "ar" to "العالم", "pt" to "Mundo",
            "es" to "Mundo", "fr" to "Monde", "la" to "Mundus",
        ),
        "external" to mapOf(
            "zh" to "外部", "en" to "External", "ar" to "خارجي", "pt" to "Externo",
            "es" to "Externo", "fr" to "Externe", "la" to "Externus",
        ),
        "agents" to mapOf(
            "zh" to "智能体", "en" to "Agents", "ar" to "الوكلاء", "pt" to "Agentes",
            "es" to "Agentes", "fr" to "Agents", "la" to "Agentia",
        ),
        "groups" to mapOf(
            "zh" to "群组", "en" to "Groups", "ar" to "المجموعات", "pt" to "Grupos",
            "es" to "Grupos", "fr" to "Groupes", "la" to "Greges",
        ),
        "settings" to mapOf(
            "zh" to "设置", "en" to "Settings", "ar" to "الإعدادات", "pt" to "Ajustes",
            "es" to "Ajustes", "fr" to "Paramètres", "la" to "Optiones",
        ),
        "language" to mapOf(
            "zh" to "语言", "en" to "Language", "ar" to "اللغة", "pt" to "Idioma",
            "es" to "Idioma", "fr" to "Langue", "la" to "Lingua",
        ),
        "phone" to mapOf(
            "zh" to "手机号", "en" to "Phone", "ar" to "الهاتف", "pt" to "Telefone",
            "es" to "Teléfono", "fr" to "Téléphone", "la" to "Telephonum",
        ),
        "bluetooth" to mapOf(
            "zh" to "蓝牙", "en" to "Bluetooth", "ar" to "بلوتوث", "pt" to "Bluetooth",
            "es" to "Bluetooth", "fr" to "Bluetooth", "la" to "Bluetooth",
        ),
        "link" to mapOf(
            "zh" to "链接", "en" to "Link", "ar" to "الاتصال", "pt" to "Ligação",
            "es" to "Enlace", "fr" to "Lien", "la" to "Nexus",
        ),
        "data" to mapOf(
            "zh" to "数据", "en" to "Data", "ar" to "البيانات", "pt" to "Dados",
            "es" to "Datos", "fr" to "Données", "la" to "Data",
        ),
        "version" to mapOf(
            "zh" to "版本", "en" to "Version", "ar" to "الإصدار", "pt" to "Versão",
            "es" to "Versión", "fr" to "Version", "la" to "Versio",
        ),
        "model" to mapOf(
            "zh" to "模型", "en" to "Model", "ar" to "النموذج", "pt" to "Modelo",
            "es" to "Modelo", "fr" to "Modèle", "la" to "Modellum",
        ),
        "login" to mapOf(
            "zh" to "登录", "en" to "Log in", "ar" to "تسجيل الدخول", "pt" to "Entrar",
            "es" to "Iniciar sesión", "fr" to "Connexion", "la" to "Intra",
        ),
        "logged_in" to mapOf(
            "zh" to "已登录 · DID 签名验签通过", "en" to "logged in · DID signature verified",
            "ar" to "مسجّل · تم التحقق من التوقيع", "pt" to "conectado · assinatura verificada",
            "es" to "sesión iniciada · firma verificada", "fr" to "connecté · signature vérifiée",
            "la" to "inus · signo probatus",
        ),
        "login_fail" to mapOf(
            "zh" to "登录失败", "en" to "login failed", "ar" to "فشل الدخول",
            "pt" to "falha ao entrar", "es" to "fallo al entrar",
            "fr" to "échec de connexion", "la" to "intrare non potuit",
        ),
        "sync_same" to mapOf(
            "zh" to "与桌面/CLI 同源", "en" to "same as desktop/CLI", "ar" to "نفس الحاسوب/الطرفية",
            "pt" to "igual ao desktop/CLI", "es" to "igual que escritorio/CLI",
            "fr" to "identique au bureau/CLI", "la" to "idem ac mensa/CLI",
        ),
        "not_bound" to mapOf(
            "zh" to "未绑定（在电脑/手机 Web UI 绑定）", "en" to "not bound (bind in web UI)",
            "ar" to "غير مرتبط (اربطه من الويب)", "pt" to "não vinculado (vincule na web)",
            "es" to "no vinculado (vincule en la web)", "fr" to "non lié (lier sur le web)",
            "la" to "non ligatum (liga in tela)",
        ),
        "bt_from_phone" to mapOf(
            "zh" to "由手机端配对", "en" to "paired from phone", "ar" to "يُقرن من الهاتف",
            "pt" to "emparelhado pelo telefone", "es" to "emparejado desde el teléfono",
            "fr" to "appairé depuis le téléphone", "la" to "a telephono iunctum",
        ),
        "tap_lang" to mapOf(
            "zh" to "单击：切换语言", "en" to "Tap: switch language", "ar" to "انقر: تغيير اللغة",
            "pt" to "Toque: mudar idioma", "es" to "Toca: cambiar idioma",
            "fr" to "Appuyez : changer de langue", "la" to "Tange: muta linguam",
        ),
        "swipe_next" to mapOf(
            "zh" to "往后滑:下一条", "en" to "swipe: next", "ar" to "اسحب: التالي",
            "pt" to "deslize: próximo", "es" to "desliza: siguiente",
            "fr" to "glissez : suivant", "la" to "labere: sequens",
        ),
        "swipe_prev" to mapOf(
            "zh" to "往前滑:回上一条", "en" to "swipe back: previous", "ar" to "اسحب للخلف: السابق",
            "pt" to "deslize: anterior", "es" to "desliza: anterior",
            "fr" to "glissez : précédent", "la" to "labere retro: prior",
        ),
        "tap_confirm" to mapOf(
            "zh" to "单击:确认", "en" to "tap: confirm", "ar" to "انقر: تأكيد",
            "pt" to "toque: confirmar", "es" to "toca: confirmar",
            "fr" to "appuyez : confirmer", "la" to "tange: confirma",
        ),
        "dbl_exit" to mapOf(
            "zh" to "双击:返回/退出", "en" to "double-tap: back/exit", "ar" to "انقر مرتين: رجوع/خروج",
            "pt" to "toque duplo: voltar/sair", "es" to "doble toque: volver/salir",
            "fr" to "double appui : retour/quitter", "la" to "bis tange: redi/exi",
        ),
        "long_min" to mapOf(
            "zh" to "长按:选中标签→单击最小化", "en" to "long-press: select label, tap to minimize",
            "ar" to "اضغط مطولاً: اختر التسمية ثم انقر للتصغير",
            "pt" to "toque longo: selecionar rótulo, toque para minimizar",
            "es" to "pulsación larga: elegir etiqueta, toca para minimizar",
            "fr" to "appui long : sélectionner, appuyer pour réduire",
            "la" to "preme diu: elige titulum, tange ut minuas",
        ),
        "empty_world" to mapOf(
            "zh" to "世界还没有卡片", "en" to "No world cards yet", "ar" to "لا بطاقات بعد",
            "pt" to "Sem cartões ainda", "es" to "Sin tarjetas aún",
            "fr" to "Pas encore de cartes", "la" to "Nullae tabulae adhuc",
        ),
        "empty_external" to mapOf(
            "zh" to "暂无外部智能体", "en" to "No external agents", "ar" to "لا وكلاء خارجيون",
            "pt" to "Sem agentes externos", "es" to "Sin agentes externos",
            "fr" to "Aucun agent externe", "la" to "Nulli agentes externi",
        ),
        "empty_agents" to mapOf(
            "zh" to "还没有智能体", "en" to "No agents yet", "ar" to "لا وكلاء بعد",
            "pt" to "Sem agentes ainda", "es" to "Sin agentes aún",
            "fr" to "Pas encore d'agents", "la" to "Nulli agentes adhuc",
        ),
        "empty_groups" to mapOf(
            "zh" to "还没有群组", "en" to "No groups yet", "ar" to "لا مجموعات بعد",
            "pt" to "Sem grupos ainda", "es" to "Sin grupos aún",
            "fr" to "Pas encore de groupes", "la" to "Nulli greges adhuc",
        ),
        "speak" to mapOf(
            "zh" to "单击说话", "en" to "tap to speak", "ar" to "انقر للتحدث",
            "pt" to "toque para falar", "es" to "toca para hablar",
            "fr" to "appuyez pour parler", "la" to "tange ut loquaris",
        ),
        "listening" to mapOf(
            "zh" to "正在听… 再次单击发送", "en" to "listening… tap to send", "ar" to "أستمع… انقر للإرسال",
            "pt" to "ouvindo… toque para enviar", "es" to "escuchando… toca para enviar",
            "fr" to "écoute… appuyez pour envoyer", "la" to "audio… tange ut mittas",
        ),
        "connected" to mapOf(
            "zh" to "已连桌面", "en" to "desktop connected", "ar" to "متصل بالحاسوب",
            "pt" to "ligado ao desktop", "es" to "conectado al escritorio",
            "fr" to "bureau connecté", "la" to "cum mensa iunctum",
        ),
        "confirm_login" to mapOf(
            "zh" to "确认登录", "en" to "Confirm login", "ar" to "تأكيد الدخول",
            "pt" to "Confirmar entrada", "es" to "Confirmar sesión",
            "fr" to "Confirmer la connexion", "la" to "Confirma introitum",
        ),
        "login_howto" to mapOf(
            "zh" to "单击：打开摄像头，扫手机/电脑上的二维码\n往后滑：眼镜出 6 位码，在手机/电脑的 /login 里输入授权\n\n登录后这台眼镜直接用节点的身份，不用再输密码。",
            "en" to "Tap: open camera and scan the QR on your phone/desktop\nSwipe: show a 6-char code, enter it at /login to authorize\n\nAfter that the glasses use the node identity — no password.",
            "ar" to "انقر: افتح الكاميرا وامسح رمز الهاتف/الحاسوب\nاسحب: أظهر رمزاً من 6 أحرف وأدخله في /login للتصريح",
            "pt" to "Toque: abra a câmera e leia o QR do telefone/desktop\nDeslize: mostre um código de 6 caracteres e autorize em /login",
            "es" to "Toca: abre la cámara y escanea el QR del teléfono/escritorio\nDesliza: muestra un código de 6 caracteres y autoriza en /login",
            "fr" to "Appuyez : ouvrez la caméra et scannez le QR du téléphone/bureau\nGlissez : affichez un code à 6 caractères et autorisez sur /login",
            "la" to "Tange: aperi cameram et lege codicem telephoni/mensae\nLabere: ostende codicem sex litterarum et proba in /login",
        ),
        "login_confirm_hint" to mapOf(
            "zh" to "单击:扫码登录 · 往后滑:眼镜出码 · 双击:返回",
            "en" to "tap: scan · swipe: show code · double-tap: back",
            "ar" to "انقر: مسح · اسحب: رمز · نقرتان: رجوع",
            "pt" to "toque: ler QR · deslize: código · toque duplo: voltar",
            "es" to "toca: escanear · desliza: código · doble toque: volver",
            "fr" to "appuyez : scanner · glissez : code · double : retour",
            "la" to "tange: lege · labere: codex · bis tange: redi",
        ),
        "scan_qr" to mapOf(
            "zh" to "对准二维码", "en" to "Aim at the QR", "ar" to "وجّه إلى الرمز",
            "pt" to "Aponte para o QR", "es" to "Apunta al QR",
            "fr" to "Visez le QR", "la" to "Dirige ad codicem",
        ),
        "scanning" to mapOf(
            "zh" to "识别中…", "en" to "reading…", "ar" to "جارٍ القراءة…",
            "pt" to "lendo…", "es" to "leyendo…", "fr" to "lecture…",
            "la" to "legens…",
        ),
        "scan_howto" to mapOf(
            "zh" to "把镜片对准手机/电脑屏幕上的二维码\n电脑上打开 http://127.0.0.1:54188/login 就能看到码",
            "en" to "Point the glasses at the QR shown on your phone/desktop\nOpen http://127.0.0.1:54188/login on the desktop",
            "ar" to "وجّه النظارة إلى الرمز على شاشة الهاتف/الحاسوب\nافتح http://127.0.0.1:54188/login على الحاسوب",
            "pt" to "Aponte os óculos para o QR no telefone/desktop\nAbra http://127.0.0.1:54188/login no desktop",
            "es" to "Apunta las gafas al QR del teléfono/escritorio\nAbre http://127.0.0.1:54188/login en el escritorio",
            "fr" to "Pointez les lunettes vers le QR du téléphone/bureau\nOuvrez http://127.0.0.1:54188/login sur le bureau",
            "la" to "Dirige perspicilla ad codicem in telephono/mensa\nAperi http://127.0.0.1:54188/login in mensa",
        ),
        "login_scan_hint" to mapOf(
            "zh" to "单击:再拍一次 · 往后滑:改用 6 位码 · 双击:返回",
            "en" to "tap: shoot again · swipe: use 6-char code · double-tap: back",
            "ar" to "انقر: صوّر ثانياً · اسحب: استخدم رمزاً · نقرتان: رجوع",
            "pt" to "toque: tirar de novo · deslize: usar código · duplo: voltar",
            "es" to "toca: otra foto · desliza: usar código · doble: volver",
            "fr" to "appuyez : reprendre · glissez : code · double : retour",
            "la" to "tange: iterum · labere: codex · bis tange: redi",
        ),
        "login_code" to mapOf(
            "zh" to "眼镜出的码", "en" to "code from glasses", "ar" to "رمز النظارة",
            "pt" to "código dos óculos", "es" to "código de las gafas",
            "fr" to "code des lunettes", "la" to "codex perspicillorum",
        ),
        "code_howto" to mapOf(
            "zh" to "在手机/电脑打开 /login，把这个码输进去点「授权这台眼镜」\n（手机同 Wi-Fi 时：BOLLOON_BIND=0.0.0.0 起节点，用 http://<电脑 IP>:54188/login）",
            "en" to "Open /login on your phone/desktop, type this code, tap \"Authorize these glasses\"\n(phone on same Wi-Fi: start node with BOLLOON_BIND=0.0.0.0 and use http://<mac-ip>:54188/login)",
            "ar" to "افتح /login على الهاتف/الحاسوب وأدخل الرمز ثم «صرّح بهذه النظارة»",
            "pt" to "Abra /login no telefone/desktop, digite o código e toque em \"Autorizar estes óculos\"",
            "es" to "Abre /login en el teléfono/escritorio, escribe el código y toca \"Autorizar estas gafas\"",
            "fr" to "Ouvrez /login sur le téléphone/bureau, saisissez le code puis \"Autoriser ces lunettes\"",
            "la" to "Aperi /login in telephono/mensa, scribe codicem, tange probare",
        ),
        "code_requesting" to mapOf(
            "zh" to "正在取码…", "en" to "requesting code…", "ar" to "جارٍ طلب الرمز…",
            "pt" to "pedindo código…", "es" to "pidiendo código…",
            "fr" to "demande du code…", "la" to "codex petens…",
        ),
        "code_none" to mapOf(
            "zh" to "还没拿到码 · 单击重试", "en" to "no code yet · tap to retry",
            "ar" to "لا رمز بعد · انقر للمحاولة", "pt" to "sem código · toque para tentar",
            "es" to "sin código · toca para reintentar", "fr" to "pas de code · appuyez",
            "la" to "nullus codex · tange",
        ),
        "code_wait" to mapOf(
            "zh" to "等授权中…（每 2 秒查一次）", "en" to "waiting for approval… (every 2s)",
            "ar" to "بانتظار التصريح…", "pt" to "aguardando autorização…",
            "es" to "esperando autorización…", "fr" to "en attente d'autorisation…",
            "la" to "probationem exspectans…",
        ),
        "login_code_hint" to mapOf(
            "zh" to "单击:换一张码 · 往前滑:回扫码 · 双击:返回",
            "en" to "tap: new code · swipe back: scan · double-tap: back",
            "ar" to "انقر: رمز جديد · اسحب للخلف: مسح · نقرتان: رجوع",
            "pt" to "toque: novo código · deslize: ler QR · duplo: voltar",
            "es" to "toca: nuevo código · desliza: escanear · doble: volver",
            "fr" to "appuyez : nouveau code · glissez : scanner · double : retour",
            "la" to "tange: novus codex · labere retro: lege · bis tange: redi",
        ),
        "code_expired" to mapOf(
            "zh" to "码过期了，单击换一张", "en" to "code expired · tap for a new one",
            "ar" to "انتهى الرمز · انقر لرمز جديد", "pt" to "código expirado · toque para novo",
            "es" to "código caducado · toca uno nuevo", "fr" to "code expiré · appuyez",
            "la" to "codex exspiravit · tange",
        ),
        "code_fail" to mapOf(
            "zh" to "取码失败（节点在跑吗）· 单击重试", "en" to "cannot get code (node up?) · tap to retry",
            "ar" to "فشل جلب الرمز · انقر للمحاولة", "pt" to "falha ao obter código · toque",
            "es" to "no se pudo obtener código · toca", "fr" to "code indisponible · appuyez",
            "la" to "codex non praesto · tange",
        ),
        "scan_timeout" to mapOf(
            "zh" to "摄像头没出图 · 往后滑改用 6 位码", "en" to "no frame from camera · swipe to use a 6-char code",
            "ar" to "لا صورة · اسحب لاستخدام رمز", "pt" to "sem imagem · deslize para usar código",
            "es" to "sin imagen · desliza para usar código", "fr" to "pas d'image · glissez pour un code",
            "la" to "nulla imago · labere ut codex",
        ),
        "dev_skip" to mapOf(
            "zh" to "长按:跳过登录(开发者)", "en" to "long-press: skip login (dev)",
            "ar" to "اضغط مطولاً: تخطي الدخول (مطوّر)", "pt" to "toque longo: pular login (dev)",
            "es" to "pulsación larga: omitir login (dev)", "fr" to "appui long : ignorer (dev)",
            "la" to "preme diu: transi introitum (dev)",
        ),
        "disconnected" to mapOf(
            "zh" to "未连桌面", "en" to "desktop offline", "ar" to "الحاسوب غير متصل",
            "pt" to "desktop offline", "es" to "escritorio sin conexión",
            "fr" to "bureau hors ligne", "la" to "mensa non iuncta",
        ),
    )

    /** 取某条文案；缺失就退回英文，再退回中文 */
    fun t(lang: String, key: String): String {
        val row = table[key] ?: return key
        return row[lang] ?: row["en"] ?: row["zh"] ?: key
    }

    fun has(key: String): Boolean = table.containsKey(key)

    fun keys(): Set<String> = table.keys
}
