"use strict";

const app = document.getElementById("app");
const JOBS_KEY = "jobs";
const STAGES = {
  queued: "En cola",
  starting: "Iniciando",
  converting: "Convirtiendo audio",
  transcribing: "Transcribiendo",
  diarizing: "Detectando hablantes",
  refining: "Refinando con LLM",
};
const PALETTE = [
  { badge: "bg-sky-100 text-sky-800", bar: "border-sky-300" },
  { badge: "bg-emerald-100 text-emerald-800", bar: "border-emerald-300" },
  { badge: "bg-violet-100 text-violet-800", bar: "border-violet-300" },
  { badge: "bg-rose-100 text-rose-800", bar: "border-rose-300" },
  { badge: "bg-fuchsia-100 text-fuchsia-800", bar: "border-fuchsia-300" },
  { badge: "bg-teal-100 text-teal-800", bar: "border-teal-300" },
];
const BTN =
  "inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1 rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50";
const ACTIVE = ["bg-brand-100"];
const DIRTY = "bg-yellow-100";
// Deben coincidir con TURN_MAX_GAP y TURN_MAX_CHARS en app/pipeline.py
const TURN_MAX_GAP = 3;
const TURN_MAX_CHARS = 800;

function groupTurns(segs) {
  const turns = [];
  segs.forEach((s, i) => {
    const last = turns[turns.length - 1];
    if (
      last &&
      last.speaker === s.speaker &&
      s.start - segs[last.idx[last.idx.length - 1]].end <= TURN_MAX_GAP &&
      last.chars <= TURN_MAX_CHARS
    ) {
      last.idx.push(i);
      last.chars += s.text.length + 1;
    } else turns.push({ speaker: s.speaker, idx: [i], chars: s.text.length });
  });
  return turns;
}

let cleanup = () => {};
let guard = null;

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};

const ids = () => JSON.parse(localStorage.getItem(JOBS_KEY) || "[]");
const saveIds = (a) => localStorage.setItem(JOBS_KEY, JSON.stringify(a));

const pad = (n) => String(n).padStart(2, "0");
function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
function fmtLong(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const fmtMB = (b) => `${(b / 1e6).toFixed(1)} MB`;

let toastTimer;
function toast(msg, isErr = false) {
  const box = document.getElementById("toast");
  const el = h(
    "div",
    { class: `rounded-md px-4 py-2 text-sm shadow-lg ${isErr ? "bg-red-600 text-white" : "bg-slate-900 text-white"}` },
    msg,
  );
  box.replaceChildren(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.replaceChildren(), 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fuera de localhost sin HTTPS el portapapeles moderno no esta disponible
    const ta = h("textarea", { class: "fixed opacity-0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  }
}

function upload(file, opts, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("language", opts.language);
    if (opts.diarize) fd.append("diarize", "true");
    if (opts.speakers) fd.append("num_speakers", opts.speakers);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* respuesta sin JSON */ }
      if (xhr.status < 300) resolve(body.id);
      else reject(new Error(typeof body.detail === "string" ? body.detail : `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Error de red"));
    xhr.send(fd);
  });
}

function progressBar(pct) {
  const inner =
    pct == null
      ? h("div", { class: "h-full w-full animate-pulse bg-brand-300" })
      : h("div", { class: "h-full bg-brand-600 transition-all", style: `width:${pct}%` });
  return h("div", { class: "h-2 overflow-hidden rounded-full bg-slate-200" }, inner);
}

/* ---------- Inicio ---------- */

function home() {
  let files = [];
  let stopped = false;
  let timer;

  const input = h("input", {
    type: "file",
    multiple: true,
    accept: "audio/*,video/*,.m4a,.mkv",
    class: "sr-only",
    onchange: () => setFiles([...input.files]),
  });
  const dzTitle = h("p", { class: "font-medium text-slate-700" }, "Arrastra audios o videos aquí");
  const dzSub = h("p", { class: "text-sm text-slate-500" }, "o haz clic para elegirlos · mp3, wav, m4a, mp4, mov…");
  const drop = h(
    "label",
    {
      class:
        "flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-10 text-center transition-colors hover:border-brand-400 focus-within:border-brand-500",
      ondragover: (e) => { e.preventDefault(); drop.classList.add("border-brand-500", "bg-brand-50"); },
      ondragleave: () => drop.classList.remove("border-brand-500", "bg-brand-50"),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove("border-brand-500", "bg-brand-50");
        setFiles([...e.dataTransfer.files]);
      },
    },
    input,
    dzTitle,
    dzSub,
  );

  const language = h(
    "select",
    { class: "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" },
    h("option", { value: "" }, "Detectar"),
    h("option", { value: "es" }, "Español"),
    h("option", { value: "en" }, "English"),
  );
  const diarize = h("input", { type: "checkbox", class: "size-4 accent-brand-600", onchange: () => (speakers.disabled = !diarize.checked) });
  const speakers = h("input", { type: "number", min: "1", max: "20", placeholder: "auto", disabled: true, class: "w-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100" });
  const submit = h("button", { class: BTN_PRIMARY, disabled: true, onclick: send }, "Transcribir");
  const barBox = h("div", { class: "hidden space-y-1" });
  const msg = h("p", { class: "text-sm text-red-600" });

  const form = h(
    "div",
    { class: "space-y-4" },
    drop,
    h(
      "div",
      { class: "flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3" },
      h("label", { class: "flex items-center gap-2 text-sm" }, "Idioma", language),
      h("label", { class: "flex items-center gap-2 text-sm" }, diarize, "Separar hablantes"),
      h("label", { class: "flex items-center gap-2 text-sm text-slate-600" }, "Nº de hablantes", speakers),
      h("div", { class: "ml-auto" }, submit),
    ),
    barBox,
    msg,
  );

  function setFiles(list) {
    files = list;
    dzTitle.textContent = list.length === 1 ? list[0].name : list.length ? `${list.length} archivos seleccionados` : "Arrastra audios o videos aquí";
    dzSub.textContent = list.length ? fmtMB(list.reduce((a, f) => a + f.size, 0)) : "o haz clic para elegirlos · mp3, wav, m4a, mp4, mov…";
    submit.disabled = !list.length;
  }

  async function send() {
    const opts = { language: language.value, diarize: diarize.checked, speakers: speakers.value };
    const batch = files;
    submit.disabled = true;
    msg.textContent = "";
    barBox.classList.remove("hidden");
    let failed = 0;
    for (const [i, f] of batch.entries()) {
      const label = h("p", { class: "text-sm text-slate-600" });
      const bar = h("div", { class: "h-full bg-brand-600 transition-all", style: "width:0%" });
      barBox.replaceChildren(label, h("div", { class: "h-2 overflow-hidden rounded-full bg-slate-200" }, bar));
      try {
        const id = await upload(f, opts, (p) => {
          label.textContent = `Subiendo ${i + 1}/${batch.length}: ${f.name} · ${Math.round(p * 100)}%`;
          bar.style.width = `${p * 100}%`;
        });
        saveIds([...ids(), id]);
      } catch (e) {
        failed++;
        msg.textContent = `${f.name}: ${e.message}`;
      }
    }
    barBox.classList.add("hidden");
    if (!failed) {
      input.value = "";
      setFiles([]);
    } else submit.disabled = false;
    refresh();
  }

  const empty = h("p", { class: "rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500" }, "Aún no has subido archivos.");
  const list = h("ul", { class: "space-y-3" });

  function card(j) {
    const active = j.status === "queued" || j.status === "processing";
    const pct = j.stage === "transcribing" && j.progress != null ? Math.round(j.progress * 100) : null;
    let body;
    if (j.status === "done") {
      body = h(
        "div",
        { class: "flex flex-wrap items-center gap-2" },
        h("a", { href: `#/t/${j.id}`, class: BTN_PRIMARY }, "Ver transcript"),
        ...["txt", "srt", "json"].map((f) => h("a", { href: `/api/jobs/${j.id}/download/${f}`, class: BTN }, f.toUpperCase())),
      );
    } else if (j.status === "error") {
      body = h("p", { class: "text-sm text-red-600" }, j.error || "Falló el procesamiento");
    } else {
      const label = (STAGES[j.stage] || j.stage) + (pct != null ? ` ${pct}%` : "");
      body = h("div", { class: "space-y-1.5" }, h("p", { class: "text-sm text-slate-600" }, label), progressBar(pct));
    }
    const sub = j.status === "done" && j.audio_seconds ? h("span", { class: "text-xs text-slate-500" }, fmt(j.audio_seconds)) : null;
    return h(
      "li",
      { class: `space-y-3 rounded-xl border bg-white p-4 ${j.status === "error" ? "border-red-200" : "border-slate-200"}` },
      h(
        "div",
        { class: "flex items-start justify-between gap-3" },
        h("p", { class: "min-w-0 flex-1 truncate font-medium text-slate-900", title: j.filename }, j.filename),
        sub,
        active ? null : h("button", { class: "text-xs text-slate-400 hover:text-slate-700", title: "Quitar de esta lista (no borra el archivo del servidor)", onclick: () => { saveIds(ids().filter((x) => x !== j.id)); refresh(); } }, "Quitar"),
      ),
      body,
    );
  }

  async function refresh() {
    clearTimeout(timer);
    const current = ids();
    const rows = await Promise.all(
      current.map(async (id) => {
        try {
          const r = await fetch(`/api/jobs/${id}`);
          if (r.status === 404) return { id, gone: true };
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      }),
    );
    if (stopped) return;
    const gone = rows.filter((r) => r && r.gone).map((r) => r.id);
    if (gone.length) saveIds(ids().filter((id) => !gone.includes(id)));
    const jobs = rows.filter((r) => r && !r.gone).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    list.replaceChildren(...jobs.map(card));
    empty.hidden = jobs.length > 0;
    const busy = jobs.some((j) => j.status === "queued" || j.status === "processing");
    timer = setTimeout(refresh, busy ? 1500 : 5000);
  }

  app.replaceChildren(form, h("h2", { class: "mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500" }, "Tus archivos"), empty, list);
  document.title = "Transcripciones";
  cleanup = () => { stopped = true; clearTimeout(timer); };
  refresh();
}

/* ---------- Visor ---------- */

function viewer(id) {
  let stopped = false;
  let timer;
  const back = h("a", { href: "#/", class: "text-sm text-slate-500 hover:text-slate-800" }, "← Archivos");
  const status = h("p", { class: "text-sm text-slate-600" }, "Cargando…");
  const holder = h("div", { class: "space-y-3" }, status);
  app.replaceChildren(back, h("div", { class: "mt-4" }, holder));
  cleanup = () => { stopped = true; clearTimeout(timer); };

  function fail(text) {
    status.textContent = text;
    status.className = "text-sm text-red-600";
  }

  async function load() {
    clearTimeout(timer);
    let r;
    try { r = await fetch(`/api/jobs/${id}`); } catch { return fail("No se pudo conectar con el servidor."); }
    if (stopped) return;
    if (!r.ok) return fail("No se encontró este archivo.");
    const j = await r.json();
    if (j.status === "error") return fail(j.error || "Falló el procesamiento.");
    if (j.status !== "done") {
      const pct = j.stage === "transcribing" && j.progress != null ? Math.round(j.progress * 100) : null;
      status.textContent = `${j.filename}: ${(STAGES[j.stage] || j.stage)}${pct != null ? ` ${pct}%` : ""}`;
      holder.replaceChildren(status, progressBar(pct));
      timer = setTimeout(load, 1500);
      return;
    }
    const tr = await fetch(`/api/jobs/${id}/transcript`);
    if (stopped) return;
    if (!tr.ok) return fail("No se pudo cargar el transcript.");
    mount(await tr.json());
  }

  function mount(t) {
    const segs = t.segments;
    const texts = segs.map((s) => s.text);
    const saved = [...texts];
    const speakers = [...new Set(segs.map((s) => s.speaker).filter(Boolean))];
    const names = { ...(t.speaker_names || {}) };
    const defaultName = (sp) => {
      const m = /^SPEAKER_(\d+)$/.exec(sp);
      return m ? `Hablante ${+m[1] + 1}` : sp;
    };
    const nameOf = (sp) => names[sp] || defaultName(sp);
    const badges = {};
    const color = (sp) => PALETTE[speakers.indexOf(sp) % PALETTE.length];
    const dirty = () => texts.some((x, i) => x !== saved[i]);
    let editing = false;
    let active = -1;

    document.title = `${t.filename} · Transcripciones`;

    const audio = h("audio", { controls: true, preload: "metadata", src: `/api/jobs/${id}/audio`, class: "w-full" });
    const follow = h("input", { type: "checkbox", checked: true, class: "size-4 accent-brand-600" });
    const rate = h(
      "select",
      { class: "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm", title: "Velocidad", onchange: () => (audio.playbackRate = +rate.value) },
      ...[0.75, 1, 1.25, 1.5, 2].map((v) => h("option", { value: v, selected: v === 1 }, `${v}x`)),
    );
    const skip = (d) => (audio.currentTime = Math.max(0, audio.currentTime + d));

    function seek(time) {
      audio.currentTime = time;
      audio.play().catch(() => {});
      document.activeElement?.blur();
    }

    /* Segmentos */
    const rows = segs.map((s, i) => {
      const span = h("span", { class: "scroll-mt-44 rounded outline-none" }, texts[i]);
      span.addEventListener("click", () => { if (!editing) seek(s.start); });
      span.addEventListener("input", () => {
        texts[i] = span.textContent;
        span.classList.toggle(DIRTY, texts[i] !== saved[i]);
        refreshControls();
      });
      return { row: span, text: span };
    });

    function updateBadges() {
      for (const [sp, list] of Object.entries(badges)) list.forEach((b) => (b.textContent = nameOf(sp)));
    }
    function makeBadge(sp) {
      const b = h(
        "button",
        {
          class: `rounded-full px-2.5 py-0.5 text-xs font-semibold hover:ring-2 hover:ring-brand-300 ${color(sp).badge}`,
          title: "Clic para renombrar",
          onclick: () => rename(sp, b),
        },
        nameOf(sp),
      );
      (badges[sp] ||= []).push(b);
      return b;
    }
    function rename(sp, badge) {
      const input = h("input", {
        value: nameOf(sp),
        maxlength: "40",
        class: "w-44 rounded-full border border-brand-400 px-2.5 py-0.5 text-xs font-semibold outline-none focus:ring-2 focus:ring-brand-300",
      });
      let done = false;
      async function finish(commit) {
        if (done) return;
        done = true;
        const value = input.value.replace(/\s+/g, " ").trim();
        input.replaceWith(badge);
        if (!commit || value === nameOf(sp)) return;
        let r;
        try {
          r = await fetch(`/api/jobs/${id}/speakers`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ names: { ...names, [sp]: value } }),
          });
        } catch {
          return toast("No se pudo conectar con el servidor.", true);
        }
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))).detail;
          return toast(typeof d === "string" ? d : "No se pudo renombrar.", true);
        }
        for (const k of Object.keys(names)) delete names[k];
        Object.assign(names, (await r.json()).names);
        updateBadges();
        toast("Nombre actualizado");
      }
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      badge.replaceWith(input);
      input.focus();
      input.select();
    }

    const turns = groupTurns(segs);
    const body = h("div", { class: "space-y-4 pb-24 pt-4" });
    if (!segs.length) body.append(h("p", { class: "py-8 text-center text-sm text-slate-500" }, "No se detectó voz en este archivo."));
    if (speakers.length) body.append(h("p", { class: "text-xs text-slate-500" }, "Haz clic en el nombre de un hablante para renombrarlo."));
    for (const turn of turns) {
      const start = segs[turn.idx[0]].start;
      body.append(
        h(
          "div",
          { class: turn.speaker ? `border-l-4 pl-3 ${color(turn.speaker).bar}` : "" },
          h(
            "div",
            { class: "mb-1 flex items-center gap-2" },
            turn.speaker ? makeBadge(turn.speaker) : null,
            h("button", { class: "rounded px-1 text-xs tabular-nums text-slate-400 hover:bg-slate-200 hover:text-slate-700", title: "Ir a este momento", onclick: () => seek(start) }, fmt(start)),
          ),
          h("p", { class: "leading-relaxed" }, ...turn.idx.flatMap((i) => [rows[i].row, " "])),
        ),
      );
    }

    function setActive(i) {
      if (i === active) return;
      if (active >= 0) rows[active].row.classList.remove(...ACTIVE);
      active = i;
      if (i < 0) return;
      rows[i].row.classList.add(...ACTIVE);
      if (follow.checked) rows[i].row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    function findActive(time) {
      let lo = 0, hi = segs.length - 1, ans = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (segs[m].start <= time) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return ans;
    }
    audio.addEventListener("timeupdate", () => setActive(findActive(audio.currentTime)));

    /* Edicion */
    const editBtn = h("button", { class: BTN, onclick: () => setEditing(true) }, "Editar");
    const saveBtn = h("button", { class: BTN_PRIMARY, hidden: true, onclick: save }, "Guardar");
    const cancelBtn = h("button", { class: BTN, hidden: true, onclick: cancel }, "Cancelar");

    function refreshControls() {
      const n = texts.filter((x, i) => x !== saved[i]).length;
      saveBtn.textContent = n ? `Guardar (${n})` : "Guardar";
    }
    function setEditing(on) {
      editing = on;
      editBtn.hidden = on;
      saveBtn.hidden = cancelBtn.hidden = !on;
      for (const { text } of rows) {
        try { text.contentEditable = on ? "plaintext-only" : "false"; } catch { text.contentEditable = on ? "true" : "false"; }
        text.classList.toggle("cursor-text", on);
        text.classList.toggle("ring-1", on);
        text.classList.toggle("ring-slate-200", on);
        text.classList.toggle("cursor-pointer", !on);
        text.classList.toggle("hover:bg-brand-50", !on);
      }
      refreshControls();
    }
    function restore() {
      texts.forEach((_, i) => {
        texts[i] = saved[i];
        rows[i].text.textContent = saved[i];
        rows[i].row.classList.remove(DIRTY);
      });
    }
    function cancel() {
      if (dirty() && !confirm("¿Descartar los cambios sin guardar?")) return;
      restore();
      setEditing(false);
    }
    async function save() {
      const clean = texts.map((x) => x.replace(/\s+/g, " ").trim());
      if (clean.some((x) => !x)) return toast("Hay frases vacías: escribe algo o cancela.", true);
      saveBtn.disabled = true;
      let r;
      try {
        r = await fetch(`/api/jobs/${id}/transcript`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: clean }),
        });
      } catch {
        saveBtn.disabled = false;
        return toast("No se pudo conectar con el servidor.", true);
      }
      saveBtn.disabled = false;
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))).detail;
        return toast(typeof d === "string" ? d : "No se pudo guardar.", true);
      }
      clean.forEach((x, i) => {
        texts[i] = saved[i] = x;
        rows[i].text.textContent = x;
        rows[i].row.classList.remove(DIRTY);
      });
      setEditing(false);
      toast("Cambios guardados");
    }

    /* Barra superior */
    const copyBtn = h("button", { class: BTN, onclick: async () => {
      const txt = turns
        .map((tn) => `[${fmtLong(segs[tn.idx[0]].start)}] ${tn.speaker ? nameOf(tn.speaker) + ": " : ""}${tn.idx.map((i) => texts[i]).join(" ")}`)
        .join("\n");
      try { await copyText(txt); toast("Transcript copiado"); } catch { toast("No se pudo copiar", true); }
    } }, "Copiar");
    const downloads = ["txt", "srt", "json"].map((f) =>
      h("a", {
        href: `/api/jobs/${id}/download/${f}`,
        class: BTN,
        onclick: (e) => { if (dirty()) { e.preventDefault(); toast("Guarda los cambios antes de descargar.", true); } },
      }, f.toUpperCase()),
    );

    const info = [
      `${segs.length} frases`,
      speakers.length ? `${speakers.length} hablantes` : null,
      t.audio_seconds ? fmt(t.audio_seconds) : null,
      t.edited ? "editado" : null,
    ].filter(Boolean).join(" · ");

    const bar = h(
      "div",
      { class: "sticky top-0 z-20 -mx-4 space-y-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur" },
      h(
        "div",
        { class: "flex flex-wrap items-center gap-2" },
        h("div", { class: "w-full min-w-0 sm:w-auto sm:flex-1" },
          h("p", { class: "truncate font-semibold text-slate-900", title: t.filename }, t.filename),
          h("p", { class: "text-xs text-slate-500" }, info),
        ),
        copyBtn, ...downloads, editBtn, cancelBtn, saveBtn,
      ),
      audio,
      h(
        "div",
        { class: "flex flex-wrap items-center gap-2" },
        h("button", { class: BTN, onclick: () => skip(-10) }, "« 10 s"),
        h("button", { class: BTN, onclick: () => skip(10) }, "10 s »"),
        rate,
        h("label", { class: "ml-auto flex items-center gap-2 text-sm text-slate-600" }, follow, "Seguir reproducción"),
      ),
    );

    setEditing(false);
    holder.replaceChildren(bar, body);
    holder.parentElement.classList.remove("mt-4");

    /* Teclado y proteccion de cambios */
    const onKey = (e) => {
      if (editing || e.target.closest("input,select,textarea,button,audio,a,[contenteditable]")) return;
      if (e.code === "Space") { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
      else if (e.key === "ArrowLeft") skip(-5);
      else if (e.key === "ArrowRight") skip(5);
    };
    const onUnload = (e) => { if (dirty()) e.preventDefault(); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    guard = () => !dirty() || confirm("Tienes cambios sin guardar. ¿Salir de todos modos?");
    const base = cleanup;
    cleanup = () => {
      base();
      audio.pause();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }

  load();
}

/* ---------- Router ---------- */

let lastHash = location.hash;
function route() {
  cleanup();
  cleanup = () => {};
  guard = null;
  const m = /^#\/t\/([0-9a-f]{32})$/.exec(location.hash);
  if (m) viewer(m[1]);
  else home();
}
window.addEventListener("hashchange", () => {
  if (location.hash === lastHash) return;
  if (guard && !guard()) {
    location.hash = lastHash;
    return;
  }
  lastHash = location.hash;
  route();
});
route();
