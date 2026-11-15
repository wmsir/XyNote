/**
 * 图标的中英文搜索：把 lucide 图标名拆成英文单词，再配上中文关键词。
 * 例如 FileText → "file text 文件 文档 文字 文本"。
 */

/** 英文单词 → 中文关键词（空格分隔，可多个） */
const ZH: Record<string, string> = {
  // 文件与文档
  file: "文件 文档", files: "文件 文档", text: "文字 文本", document: "文档", page: "页面", pages: "页面",
  folder: "文件夹 目录", folders: "文件夹", archive: "归档 存档 档案", book: "书 书籍 阅读", books: "书 书架",
  notebook: "笔记本 笔记", note: "笔记 便签", notepad: "记事本 便签", sticky: "便签 便利贴", clipboard: "剪贴板 清单",
  newspaper: "报纸 新闻", library: "图书馆 书库", scroll: "卷轴 滚动", paperclip: "回形针 附件", paper: "纸",
  receipt: "收据 发票 账单", ticket: "票 门票", bookmark: "书签 收藏", sheet: "表格", spreadsheet: "表格 电子表格",
  table: "表格", list: "列表 清单", todo: "待办", check: "勾选 完成 对勾", checks: "勾选 完成", square: "方形 方块",
  circle: "圆 圆形", badge: "徽章 标记", tag: "标签", tags: "标签", hash: "井号 话题 标签", sticker: "贴纸",
  signature: "签名", stamp: "印章 盖章", pen: "钢笔 笔 书写", pencil: "铅笔 编辑 书写", highlighter: "荧光笔 高亮",
  eraser: "橡皮 擦除", brush: "刷子 画笔", paintbrush: "画笔 绘画", palette: "调色板 颜色 设计", feather: "羽毛 写作",
  type: "文字 字体", heading: "标题", quote: "引用", text_cursor: "光标", letter: "字母 信", languages: "语言 翻译",
  // 办公与工作
  briefcase: "公文包 工作 职业", calendar: "日历 日程 日期", clock: "时钟 时间", timer: "计时器 倒计时", alarm: "闹钟 提醒",
  hourglass: "沙漏 时间", watch: "手表 时间", history: "历史 记录", inbox: "收件箱", mail: "邮件 邮箱 信封", mails: "邮件",
  send: "发送", message: "消息 信息 聊天", messages: "消息", chat: "聊天", phone: "电话 手机", contact: "联系人 通讯录",
  user: "用户 个人 人", users: "用户 团队 多人", person: "人", team: "团队", group: "组 群组", building: "建筑 公司 大楼",
  presentation: "演示 幻灯片 汇报", projector: "投影", kanban: "看板 任务", layout: "布局 版面", dashboard: "仪表盘 看板",
  chart: "图表 统计", bar: "柱状 条形", pie: "饼图", line: "折线 线", area: "面积", trending: "趋势 增长",
  target: "目标 靶心", goal: "目标", flag: "旗帜 标记 里程碑", milestone: "里程碑", trophy: "奖杯 冠军 成就", award: "奖励 奖章",
  medal: "奖牌", crown: "皇冠 王冠", gem: "宝石 钻石", diamond: "钻石 菱形", star: "星星 收藏 重要", stars: "星星",
  sparkle: "闪光 亮点", sparkles: "闪光 亮点 灵感 魔法", lightbulb: "灯泡 灵感 想法 创意", idea: "想法", brain: "大脑 思考 知识",
  rocket: "火箭 启动 发布", zap: "闪电 快速 电", flame: "火焰 热门", fire: "火", bolt: "闪电 螺栓",
  // 学习
  graduation: "毕业 学位 学习", cap: "帽子", school: "学校", backpack: "书包 背包", microscope: "显微镜 科学 研究",
  flask: "烧瓶 实验 化学", atom: "原子 物理 科学", dna: "基因 生物", calculator: "计算器 数学", sigma: "求和 数学",
  pi: "圆周率 数学", ruler: "尺子 测量", compass: "指南针 罗盘 方向", globe: "地球 全球 网络 世界", earth: "地球",
  // 技术
  code: "代码 编程 开发", terminal: "终端 命令行", database: "数据库", server: "服务器", cpu: "处理器 芯片", chip: "芯片",
  hard: "硬", drive: "硬盘 磁盘 网盘", cloud: "云 云端", wifi: "无线 网络", bluetooth: "蓝牙", network: "网络",
  git: "版本控制 代码", branch: "分支", commit: "提交", merge: "合并", pull: "拉取", request: "请求", bug: "虫子 缺陷 错误 调试",
  binary: "二进制", braces: "大括号 代码", brackets: "括号", variable: "变量", function: "函数", regex: "正则",
  laptop: "笔记本电脑 电脑", monitor: "显示器 电脑 屏幕", computer: "电脑", smartphone: "手机 智能手机", tablet: "平板",
  keyboard: "键盘", mouse: "鼠标", printer: "打印机 打印", usb: "接口", plug: "插头 插件", cable: "线缆", battery: "电池 电量",
  app: "应用", window: "窗口", bot: "机器人 智能", robot: "机器人", webhook: "回调", api: "接口", qr: "二维码", scan: "扫描",
  // 安全
  lock: "锁 加密 安全", unlock: "解锁", key: "钥匙 密码 密钥", shield: "盾牌 安全 防护", fingerprint: "指纹",
  eye: "眼睛 查看 可见", off: "关闭 隐藏", ban: "禁止", alert: "警告 提醒", triangle: "三角", octagon: "八边形",
  info: "信息 说明", help: "帮助", question: "问题 疑问",
  // 生活
  home: "主页 首页 家", house: "房子 家", bed: "床 睡觉 休息", bath: "浴缸 洗澡", sofa: "沙发", lamp: "台灯 灯",
  coffee: "咖啡 饮品", cup: "杯子", wine: "红酒 酒", beer: "啤酒", utensils: "餐具 吃饭 美食", pizza: "披萨 美食",
  apple: "苹果 水果", cherry: "樱桃", grape: "葡萄", banana: "香蕉", carrot: "胡萝卜 蔬菜", salad: "沙拉", cake: "蛋糕 生日",
  cookie: "饼干", ice: "冰", cream: "奶油", sandwich: "三明治", soup: "汤", egg: "鸡蛋", fish: "鱼", beef: "牛肉",
  shopping: "购物", cart: "购物车", bag: "包 袋子 购物", store: "商店", shop: "商店", gift: "礼物 礼品", package: "包裹 快递",
  box: "盒子 箱子", truck: "卡车 物流 运输", car: "汽车 开车", bus: "公交", train: "火车", plane: "飞机 旅行 出差",
  ship: "船", sailboat: "帆船", bike: "自行车 骑行", bicycle: "自行车", footprints: "脚印 足迹", map: "地图", pin: "图钉 置顶 定位",
  navigation: "导航", route: "路线", luggage: "行李 旅行", tent: "帐篷 露营", mountain: "山 登山", trees: "树林 树木", tree: "树",
  palmtree: "棕榈树 度假", palm: "棕榈", sun: "太阳 晴天 白天", moon: "月亮 夜晚", sunrise: "日出", sunset: "日落",
  rain: "雨", snowflake: "雪花 冬天", snow: "雪", wind: "风", umbrella: "雨伞", thermometer: "温度计 温度", rainbow: "彩虹",
  leaf: "叶子 植物 自然", flower: "花", sprout: "发芽 成长", clover: "三叶草 幸运", cactus: "仙人掌", waves: "波浪 海",
  droplet: "水滴", droplets: "水滴", heart: "爱心 喜欢 心", smile: "微笑 开心", laugh: "大笑", frown: "难过", meh: "一般",
  angry: "生气", party: "派对 庆祝", popper: "庆祝", balloon: "气球", music: "音乐", headphones: "耳机 音乐",
  mic: "麦克风 录音", radio: "收音机", film: "电影 胶片", clapperboard: "电影 场记板", tv: "电视", video: "视频",
  camera: "相机 拍照", image: "图片 照片", images: "图片 相册", gallery: "相册 画廊", aperture: "光圈", gamepad: "游戏手柄 游戏",
  dice: "骰子", puzzle: "拼图 插件", dumbbell: "哑铃 健身 运动", volleyball: "排球", football: "足球", baseball: "棒球",
  run: "跑步", activity: "活动 运动 心率", heartbeat: "心跳", pill: "药丸 药", stethoscope: "听诊器 医疗", hospital: "医院",
  syringe: "注射器", bandage: "绷带", baby: "婴儿 宝宝", dog: "狗 宠物", cat: "猫 宠物", bird: "鸟", rabbit: "兔子", turtle: "乌龟",
  squirrel: "松鼠", rat: "老鼠", paw: "爪印 宠物", bone: "骨头", shirt: "衬衫 衣服", glasses: "眼镜", scissors: "剪刀",
  hammer: "锤子 工具", wrench: "扳手 工具 设置", screwdriver: "螺丝刀", axe: "斧头", shovel: "铲子", drill: "电钻", construction: "施工",
  // 金融
  wallet: "钱包 财务", credit: "信用", card: "卡片 银行卡", banknote: "钞票 现金 钱", coins: "硬币 钱", dollar: "美元 钱",
  euro: "欧元", japanese: "日元", yen: "日元 人民币", piggy: "存钱罐", bank: "银行", landmark: "地标 银行", percent: "百分比 折扣",
  // 通用操作
  plus: "加 新建 添加", minus: "减 删除", x: "关闭 叉 错", search: "搜索 查找", filter: "筛选 过滤", settings: "设置",
  cog: "齿轮 设置", sliders: "调节 滑块", menu: "菜单", more: "更多", grid: "网格", columns: "列", rows: "行", panel: "面板",
  sidebar: "侧栏", maximize: "最大化", minimize: "最小化", expand: "展开", shrink: "收起", refresh: "刷新", rotate: "旋转",
  repeat: "重复 循环", shuffle: "随机", undo: "撤销", redo: "重做", save: "保存", download: "下载", upload: "上传", share: "分享",
  link: "链接", unlink: "取消链接", external: "外部", copy: "复制", trash: "垃圾桶 删除", delete: "删除",
  edit: "编辑", zoom: "缩放", move: "移动", hand: "手", pointer: "指针", touch: "触摸", thumbs: "点赞",
  up: "上 向上", down: "下 向下", left: "左", right: "右", arrow: "箭头", arrows: "箭头", chevron: "箭头 折角", corner: "拐角", log: "日志", in: "进入", out: "退出", power: "电源 开关", toggle: "开关 切换", play: "播放 开始", pause: "暂停",
  stop: "停止", skip: "跳过", forward: "前进 快进", back: "后退", fast: "快", volume: "音量", bell: "铃铛 通知 提醒",
  notification: "通知", megaphone: "喇叭 公告 宣传", speaker: "扬声器", rss: "订阅", podcast: "播客", at: "艾特 邮件",
  wand: "魔法棒", magic: "魔法", crop: "裁剪", layers: "图层", frame: "画框 框架", shapes: "形状", pentagon: "五边形",
  hexagon: "六边形", cone: "圆锥", cylinder: "圆柱", cube: "立方体", component: "组件", blocks: "积木 模块", workflow: "工作流 流程", infinity: "无限", anchor: "锚", magnet: "磁铁", recycle: "回收 环保", ghost: "幽灵",
  skull: "骷髅", swords: "剑 战斗", sword: "剑", castle: "城堡", church: "教堂", factory: "工厂", warehouse: "仓库",
  hotel: "酒店", university: "大学", tower: "塔", fuel: "加油", parking: "停车", lightning: "闪电", days: "天", day: "天", week: "周", month: "月",
  number: "数字", "0": "零 0", "1": "一 1", "2": "二 2", "3": "三 3", "4": "四 4", "5": "五 5", "6": "六 6", "7": "七 7", "8": "八 8", "9": "九 9",
  a: "", z: "", ab: "", abc: "字母",
};

/** ArrowDown01 → ["arrow","down","0","1"] */
export function splitIconName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/([0-9])(?=[0-9])/g, "$1 ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

const cache = new Map<string, string>();

/** 图标的可搜索文字：英文单词 + 中文关键词 */
export function iconSearchText(name: string): string {
  let hit = cache.get(name);
  if (hit) return hit;
  const words = splitIconName(name);
  const zh = words.map((w) => ZH[w] ?? ZH[w.replace(/s$/, "")] ?? "").filter(Boolean);
  hit = `${name.toLowerCase()} ${words.join(" ")} ${words.join("-")} ${zh.join(" ")}`;
  cache.set(name, hit);
  return hit;
}

/** 查询词全部命中才算匹配（空格分隔，不区分大小写） */
export function iconMatches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = iconSearchText(name);
  return q.split(/\s+/).every((t) => text.includes(t));
}

/** 没有搜索时排在最前面的常用图标 */
export const POPULAR_ICONS = [
  "FileText", "Notebook", "BookOpen", "Library", "Bookmark", "Lightbulb", "Sparkles", "Rocket", "Target", "Flag",
  "Star", "Heart", "Calendar", "CalendarDays", "Clock", "AlarmClock", "ListTodo", "SquareCheckBig", "ClipboardList", "Kanban",
  "LayoutGrid", "Table", "Database", "Folder", "Archive", "Inbox", "Mail", "MessageCircle", "Users", "User",
  "Briefcase", "Building2", "Presentation", "ChartColumn", "ChartPie", "TrendingUp", "Wallet", "PiggyBank", "CreditCard", "ShoppingCart",
  "Gift", "Trophy", "Award", "Crown", "Gem", "Zap", "Flame", "Code", "Terminal", "Server",
  "Cpu", "Bug", "GitBranch", "Globe", "Cloud", "Lock", "KeyRound", "Shield", "Settings", "Wrench",
  "Hammer", "Palette", "PenTool", "Pencil", "Feather", "Brush", "Camera", "Image", "Film", "Music",
  "Headphones", "Gamepad2", "Dumbbell", "Bike", "Plane", "Map", "MapPin", "Mountain", "TreePine", "Leaf",
  "Sun", "Moon", "CloudRain", "Snowflake", "Coffee", "Utensils", "Pizza", "Apple", "Cake", "Home",
  "Bed", "Car", "Train", "Ship", "Dog", "Cat", "Baby", "GraduationCap", "Brain", "FlaskConical",
  "Microscope", "Atom", "Calculator", "Languages", "Newspaper", "Megaphone", "Bell", "Smile", "Laugh", "PartyPopper",
];

/** 图标颜色（null 表示跟随文字颜色） */
export const ICON_COLORS: { id: string | null; label: string }[] = [
  { id: null, label: "默认" },
  { id: "#787774", label: "灰色" },
  { id: "#9f6b53", label: "棕色" },
  { id: "#d9730d", label: "橙色" },
  { id: "#cb912f", label: "黄色" },
  { id: "#448361", label: "绿色" },
  { id: "#337ea9", label: "蓝色" },
  { id: "#9065b0", label: "紫色" },
  { id: "#c14c8a", label: "粉色" },
  { id: "#d44c47", label: "红色" },
];
