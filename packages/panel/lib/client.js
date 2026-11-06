/**
 * dsh-plugin-codegraph-panel · 浏览器端入口：设置页「代码图谱」tab
 *
 * 为什么单独一个文件：本包只有客户端半侧，宿主负责把客户端模块下发给浏览器；
 * 所以这里走 CJS factory 包装，靠宿主注入的 require 取 react，不引任何 npm 包
 * （没有构建步骤、也没有 import 语句）。
 *
 * 数据全走同源 /dsh-plugin-codegraph/api/*，无 token：面板只在用户点「刷新」或
 * 「重建索引」时请求，不轮询 —— 索引结果的变化由用户主动触发，面板不做后台任务。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-codegraph-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    /** 免 JSX 写组件（产物风格同官方插件） */
    const h = React.createElement;

    /** 宿主侧路由前缀；改这里要同步改 packages/tool/src/panel.ts */
    const API = "/dsh-plugin-codegraph/api";
    /** 工作区路径的记忆键：刷新页面还在 */
    const STORAGE_KEY = "codegraph.panel.root";
    const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

    /** 宿主主题变量优先，取不到就退中性色 */
    const C = {
      primary: "var(--dsw-alias-label-primary, #1f2328)",
      secondary: "var(--dsw-alias-label-secondary, #6e7781)",
      tertiary: "var(--dsw-alias-label-tertiary, #8c959f)",
      border: "var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))",
      bg: "var(--dsw-alias-bg-l1, rgba(0, 0, 0, 0.03))",
      danger: "var(--dsw-alias-state-error-primary, #d9534f)",
      ok: "var(--dsw-alias-state-success-primary, #2e7d32)",
    };

    const BTN = {
      font: "inherit",
      fontSize: 12,
      lineHeight: "20px",
      padding: "2px 10px",
      borderRadius: 4,
      border: "1px solid " + C.border,
      background: "transparent",
      color: C.primary,
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    const S = {
      root: {
        padding: "16px 20px",
        fontSize: "var(--dsh-content-font-size, 13px)",
        lineHeight: 1.5,
        color: C.primary,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      },
      block: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
      headRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
      h1: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.5, whiteSpace: "nowrap" },
      h3: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.5 },
      hint: { color: C.tertiary, fontSize: 12 },
      actions: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 },
      input: {
        flex: 1,
        minWidth: 220,
        boxSizing: "border-box",
        padding: "4px 8px",
        border: "1px solid " + C.border,
        borderRadius: 4,
        background: C.bg,
        color: C.primary,
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: "20px",
        outline: "none",
      },
      btn: BTN,
      btnOff: { ...BTN, color: C.tertiary, cursor: "default" },
      btnStrong: { ...BTN, fontWeight: 600 },
      meta: { display: "flex", flexWrap: "wrap", gap: "2px 18px", color: C.secondary, fontSize: 12 },
      metaItem: { display: "inline-flex", gap: 6, alignItems: "baseline", minWidth: 0 },
      metaLabel: { color: C.tertiary },
      mono: {
        fontFamily: MONO,
        fontSize: 12,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      danger: { color: C.danger, fontSize: 12, whiteSpace: "pre-wrap" },
      okText: { color: C.ok, fontSize: 12, whiteSpace: "pre-wrap" },
      muted: { color: C.tertiary, fontSize: 12 },
    };

    /** localStorage 可能被隐私模式/宿主策略禁掉，读写都吞掉异常，绝不拖垮 tab */
    function readStoredRoot() {
      try {
        if (typeof localStorage === "undefined") return "";
        const value = localStorage.getItem(STORAGE_KEY);
        if (typeof value !== "string") return "";
        // Only an absolute path can name a workspace. An earlier build stored whatever had been
        // typed, so a profile that once held a relative path (e.g. a folder name) would open this tab
        // on a red "root 必须是一个存在的绝对路径" before the user had touched anything.
        return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) ? value : "";
      } catch (err) {
        return "";
      }
    }

    function writeStoredRoot(value) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(STORAGE_KEY, value);
      } catch (err) {
        // 写不进去只意味着下次打开要重填，不影响本次操作
      }
    }

    /** 数字字段兜底，坏数据只显示 0 不崩 */
    function num(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    /** epoch 毫秒 → 本地时间 2026-11-03 10:37；无效值显示 — */
    function formatTime(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      const date = new Date(ms);
      const pad = (part) => (part < 10 ? "0" + part : String(part));
      return (
        date.getFullYear() +
        "-" +
        pad(date.getMonth() + 1) +
        "-" +
        pad(date.getDate()) +
        " " +
        pad(date.getHours()) +
        ":" +
        pad(date.getMinutes())
      );
    }

    /** 状态查询 URL；root 必须编码，路径里的空格/中文不能破坏 query */
    function stateUrl(root) {
      return API + "/state?root=" + encodeURIComponent(root);
    }

    /**
     * 统一 fetch：把网络错误、非 2xx、以及 200 里 ok:false 都收敛成 { ok, message }。
     * 组件层面只读 ok/message，任何异常都不会冒成渲染错误。
     */
    async function call(url, init) {
      try {
        const res = await fetch(url, init);
        let body = null;
        try {
          body = await res.json();
        } catch (err) {
          body = null; // 非 JSON 也不该吞掉状态码，下面按 HTTP 报
        }
        if (!res.ok || (body && body.ok === false)) {
          return { ok: false, message: (body && body.message) || "HTTP " + res.status };
        }
        return { ok: true, data: body };
      } catch (err) {
        return { ok: false, message: "请求失败：" + (err && err.message ? err.message : err) };
      }
    }

    function metaItem(key, label, value) {
      return h(
        "span",
        { key: key, style: S.metaItem },
        h("span", { style: S.metaLabel }, label),
        h("span", { style: S.mono }, value),
      );
    }

    /** 索引状态：字段来自 <root>/.codegraph/status.json（IndexStatusFile） */
    function renderStatus(status) {
      const rows = [
        h(
          "div",
          { key: "meta", style: S.meta },
          metaItem("files", "文件", String(num(status.filesIndexed))),
          metaItem("nodes", "声明", String(num(status.nodeCount))),
          metaItem("edges", "关系", String(num(status.edgeCount))),
          metaItem("unresolved", "未解析", String(num(status.unresolvedCount))),
          metaItem("internal", "疑似内部缺口", String(num(status.unresolvedLikelyInternalCount))),
          metaItem("minified", "跳过生成文件", String(num(status.filesMinified))),
          metaItem("time", "索引时间", formatTime(status.indexedAt)),
        ),
      ];

      // 语言分布是可选字段：宿主没给就不摆一行空标签
      const languages = Array.isArray(status.languages) ? status.languages : [];
      if (languages.length > 0) {
        rows.push(
          h(
            "div",
            { key: "languages", style: S.meta },
            h("span", { style: S.metaLabel }, "语言分布"),
            languages.slice(0, 12).map((row, index) =>
              h(
                "span",
                { key: "lang-" + index, style: S.metaItem },
                h(
                  "span",
                  { style: S.mono },
                  (row && row.language ? String(row.language) : "?") + " " + num(row && row.fileCount),
                ),
              ),
            ),
          ),
        );
      }

      return h("div", { style: S.block }, h("h3", { style: S.h3 }, "索引状态"), rows);
    }

    function CodegraphSection() {
      const [root, setRoot] = React.useState(readStoredRoot);
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      /** null | "refresh" | "reindex"：同时只跑一个操作 */
      const [busy, setBusy] = React.useState(null);
      /** 是否成功读过一次；用来区分「还没读」和「读到了但没 status」 */
      const [loaded, setLoaded] = React.useState(false);

      const trimmed = root.trim();

      // 打开就自动读一次。路径为空时请求不带 root，宿主用当前会话的工作区回答。
      React.useEffect(function () {
        loadStatus();
        // 只在挂载时跑：之后的读取都由「刷新」「重建」按钮驱动
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      /**
       * 服务端解析出的工作区回填到输入框。
       *
       * 用户打开设置页时通常只用关心「我现在这个会话」的索引状态，让他把会话自己的路径再抄一遍
       * 是没有意义的摩擦。请求不带 root 时宿主会回答当前会话的工作区，这里把它显示出来，之后
       * 的刷新/重建就用这个值。
       */
      function adoptResolvedRoot(asked, data) {
        const resolved = data && typeof data.root === "string" ? data.root : "";
        if (asked !== "" || resolved === "") return;
        setRoot(resolved);
        writeStoredRoot(resolved);
      }

      /** 所有错误都走 state，不 throw —— 一个 tab 不该把设置页打白 */
      async function loadStatus() {
        const asked = root.trim();
        const result = await call(asked === "" ? API + "/state" : stateUrl(asked));
        if (!result.ok) {
          // 即便这次失败（例如还没有索引），服务端也已经解析出了工作区，回填免得用户再填一次
          adoptResolvedRoot(asked, result.data);
          setError(result.message);
          return;
        }
        setError(null);
        setStatus(result.data && result.data.status ? result.data.status : null);
        setLoaded(true);
        adoptResolvedRoot(asked, result.data);
      }

      async function onRefresh() {
        if (busy !== null) return;
        if (trimmed === "") {
          setError("填一个工作区路径");
          setStatus(null);
          setNotice(null);
          return;
        }
        setBusy("refresh");
        setError(null);
        setNotice(null);
        await loadStatus();
        setBusy(null);
      }

      async function onReindex() {
        if (busy !== null) return;
        if (trimmed === "") {
          setError("填一个工作区路径");
          setStatus(null);
          setNotice(null);
          return;
        }
        setBusy("reindex");
        setError(null);
        setNotice(null);
        const result = await call(API + "/reindex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root: root.trim() }),
        });
        if (!result.ok) {
          setError(result.message);
          setBusy(null);
          return;
        }
        const data = result.data || {};
        setNotice(typeof data.message === "string" && data.message ? data.message : "已重建索引");
        // 重建后数字变了，顺手刷新一次；状态没读成只影响错误行，不影响已显示的 message
        await loadStatus();
        setBusy(null);
      }

      const refreshButton = h(
        "button",
        {
          type: "button",
          style: busy !== null ? S.btnOff : S.btn,
          disabled: busy !== null,
          title: "重新读取这个工作区的索引状态",
          onClick: onRefresh,
        },
        busy === "refresh" ? "刷新中…" : "刷新",
      );

      const reindexButton = h(
        "button",
        {
          type: "button",
          style: busy !== null ? S.btnOff : S.btnStrong,
          disabled: busy !== null,
          title: "重新索引这个工作区（会花一会儿）",
          onClick: onReindex,
        },
        busy === "reindex" ? "重建中…" : "重建索引",
      );

      const header = h(
        "div",
        { style: S.block },
        h(
          "div",
          { style: S.headRow },
          h("h2", { style: S.h1 }, "代码图谱"),
          h(
            "div",
            { style: S.actions },
            h("input", {
              style: S.input,
              type: "text",
              value: root,
              spellCheck: false,
              placeholder: "工作区路径，例如 /Users/you/project",
              title: "要查看索引状态的绝对路径",
              onChange: (event) => {
                const value = event.target.value;
                setRoot(value);
                writeStoredRoot(value);
              },
              onKeyDown: (event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onRefresh();
                }
              },
            }),
            refreshButton,
            reindexButton,
          ),
        ),
        h(
          "div",
          { style: S.hint },
          "数据来自宿主 /dsh-plugin-codegraph/api/*；路径留空会提示先填路径。",
        ),
      );

      const statusBlock = status
        ? renderStatus(status)
        : loaded
          ? h("div", { style: S.muted }, "宿主没有返回索引状态。")
          : h("div", { style: S.muted }, "还没有读取状态。");

      return h(
        "div",
        { style: S.root, "data-codegraph-panel": "" },
        header,
        error ? h("div", { style: S.danger, role: "alert" }, error) : null,
        notice ? h("div", { style: S.okText, role: "status" }, notice) : null,
        busy !== null ? h("div", { style: S.muted }, busy === "refresh" ? "读取状态中…" : "重建索引中，稍等…") : null,
        statusBlock,
      );
    }

    /**
     * 注册「代码图谱」tab。
     *
     * 两处都单独 try/catch：注册抛错会让 DSH 把 web 判成 failed，
     * 一个 tab 不该拖垮整个客户端。
     */
    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", () => {
          try {
            return ctx.slots.register(
              {
                name: "settings.section",
                id: "codegraph",
                order: 30,
                label: () => "代码图谱",
              },
              CodegraphSection,
            );
          } catch (err) {
            console.warn("[codegraph] 注册 settings.section 失败：", err);
            return null;
          }
        });
      } catch (err) {
        console.warn("[codegraph] 注入 settings.section 失败：", err);
      }
    }

    exports.name = "codegraph-panel-client";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
