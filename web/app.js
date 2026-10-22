"use strict"

const $ = (sel) => document.querySelector(sel)
const chat = $("#chat")
const form = $("#form")
const entrada = $("#entrada")
const enviarBtn = $("#enviar")
const banner = $("#banner")
const bannerLista = $("#banner-lista")
const estado = $("#estado")

let accessKey = localStorage.getItem("oc-access-key") || ""
let sessionId = localStorage.getItem("oc-session") || nuevoId()
localStorage.setItem("oc-session", sessionId)
let ocupado = false

function nuevoId() {
  return "s" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")
}

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function enLinea(texto) {
  return escapar(texto)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
}

function markdown(md) {
  const lineas = String(md).replace(/\r/g, "").split("\n")
  const html = []
  let i = 0
  const celdas = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1] || "")) {
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(`<table><thead><tr>${cab.map((c) => `<th>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = []
      while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) items.push(lineas[i++].replace(/^\s*[-*]\s+/, ""))
      html.push(`<ul>${items.map((x) => `<li>${enLinea(x)}</li>`).join("")}</ul>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = []
      while (i < lineas.length && /^\s*\d+\.\s+/.test(lineas[i])) items.push(lineas[i++].replace(/^\s*\d+\.\s+/, ""))
      html.push(`<ol>${items.map((x) => `<li>${enLinea(x)}</li>`).join("")}</ol>`)
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      html.push(`<h${h[1].length < 3 ? 3 : 4}>${enLinea(h[2])}</h${h[1].length < 3 ? 3 : 4}>`)
      i++
      continue
    }
    if (l.trim() === "") {
      i++
      continue
    }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*(\||[-*]\s|\d+\.\s|#)/.test(lineas[i])) parrafo.push(lineas[i++])
    if (parrafo.length === 0) parrafo.push(lineas[i++])
    html.push(`<p>${parrafo.map(enLinea).join("<br>")}</p>`)
  }
  return html.join("")
}

function scroll() {
  chat.scrollTop = chat.scrollHeight
}

function ocultarBienvenida() {
  const b = $("#bienvenida")
  if (b) b.remove()
}

function agregarUsuario(texto) {
  ocultarBienvenida()
  const div = document.createElement("div")
  div.className = "msg user"
  div.textContent = texto
  chat.appendChild(div)
  scroll()
}

function agregarError(texto) {
  const div = document.createElement("div")
  div.className = "msg error"
  div.textContent = "⚠ " + texto
  chat.appendChild(div)
  scroll()
}

function crearAsistente() {
  ocultarBienvenida()
  const div = document.createElement("div")
  div.className = "msg assistant"
  div.innerHTML = '<div class="tools"></div><div class="pensando">Pensando…</div><div class="burbuja" hidden></div>'
  chat.appendChild(div)
  scroll()
  return div
}

function tarjetaHerramienta(nombre, args, id) {
  const d = document.createElement("details")
  d.className = "tool corriendo"
  if (id) d.dataset.id = id
  d.innerHTML = `<summary><span class="punto"></span><span class="nombre">${escapar(nombre)}</span><span class="resumen">ejecutando…</span></summary><pre class="args"></pre>`
  d.querySelector(".args").textContent = "argumentos: " + JSON.stringify(args, null, 2)
  return d
}

function completarHerramienta(d, call) {
  d.classList.remove("corriendo")
  d.classList.add(call.ok ? "ok" : "fallo")
  d.querySelector(".resumen").textContent = call.resumen
  d.querySelector(".args").textContent = "argumentos: " + JSON.stringify(call.args, null, 2)
  if (call.forzado) {
    const f = document.createElement("div")
    f.className = "forzado"
    f.textContent = "Servidor: " + call.forzado
    d.appendChild(f)
  }
  const pre = document.createElement("pre")
  pre.textContent = "resultado: " + JSON.stringify(call.resultado, null, 2)
  d.appendChild(pre)
}

function mostrarTexto(div, texto, confirmar) {
  div.querySelector(".pensando")?.remove()
  const b = div.querySelector(".burbuja")
  b.hidden = false
  b.innerHTML = (confirmar ? '<span class="etiqueta-confirmar">Requiere tu confirmación</span>' : "") + markdown(texto)
  if (confirmar) div.classList.add("confirmar")
  scroll()
}

function mostrarBanner(confirmaciones) {
  bannerLista.innerHTML = (confirmaciones || []).map((c) => `<li><strong>${escapar(c.codigo)}</strong> ${escapar(c.detalle)}</li>`).join("")
  banner.hidden = false
}

function ocultarBanner() {
  banner.hidden = true
}

function bloquear(v) {
  ocupado = v
  enviarBtn.disabled = v
  $("#confirmar").disabled = v
  $("#cancelar").disabled = v
}

function headers() {
  const h = { "content-type": "application/json" }
  if (accessKey) h["x-access-key"] = accessKey
  return h
}

async function enviar(texto) {
  if (ocupado || !texto.trim()) return
  bloquear(true)
  ocultarBanner()
  agregarUsuario(texto)
  const div = crearAsistente()
  const tools = div.querySelector(".tools")
  const tarjetas = new Map()
  let confirmaciones = null
  let texto_final = ""
  let needs = false
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: headers(), body: JSON.stringify({ sessionId, message: texto }) })
    if (res.status === 401) {
      div.remove()
      pedirClave()
      return
    }
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}))
      div.remove()
      agregarError(j.error || `Error ${res.status}`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let corte
      while ((corte = buffer.indexOf("\n\n")) >= 0) {
        const bloque = buffer.slice(0, corte)
        buffer = buffer.slice(corte + 2)
        const data = bloque.split("\n").find((l) => l.startsWith("data: "))
        if (!data) continue
        const ev = JSON.parse(data.slice(6))
        if (ev.type === "tool_call") {
          const t = tarjetaHerramienta(ev.name, ev.args, ev.id)
          tarjetas.set(ev.id, t)
          tools.appendChild(t)
          scroll()
        } else if (ev.type === "tool_result") {
          const t = tarjetas.get(ev.call.id) || tarjetaHerramienta(ev.call.name, ev.call.args)
          if (!t.isConnected) tools.appendChild(t)
          completarHerramienta(t, ev.call)
        } else if (ev.type === "message") {
          texto_final = ev.content
        } else if (ev.type === "confirmation") {
          confirmaciones = ev.confirmaciones
        } else if (ev.type === "error") {
          div.querySelector(".pensando")?.remove()
          agregarError(ev.message)
        } else if (ev.type === "done") {
          needs = ev.needsConfirmation
        }
      }
    }
    if (texto_final) mostrarTexto(div, texto_final, needs)
    else div.querySelector(".pensando")?.remove()
    if (needs) mostrarBanner(confirmaciones)
  } catch (e) {
    div.querySelector(".pensando")?.remove()
    agregarError("No fue posible comunicarse con el servidor: " + e.message)
  } finally {
    bloquear(false)
    entrada.focus()
  }
}

function pedirClave() {
  const k = prompt("Este agente requiere una clave de acceso:")
  if (k) {
    accessKey = k.trim()
    localStorage.setItem("oc-access-key", accessKey)
    agregarError("Clave guardada. Vuelve a enviar tu mensaje.")
  } else {
    agregarError("Sin clave de acceso no es posible usar el chat.")
  }
}

async function cargarHistorial() {
  const res = await fetch(`/api/sessions/${sessionId}`, { headers: headers() })
  if (!res.ok) return
  const s = await res.json()
  for (const h of s.historial || []) {
    if (h.role === "user") agregarUsuario(h.content)
    else if (h.role === "error") agregarError(h.content)
    else {
      const div = crearAsistente()
      const tools = div.querySelector(".tools")
      for (const c of h.toolCalls || []) {
        const t = tarjetaHerramienta(c.name, c.args)
        completarHerramienta(t, c)
        tools.appendChild(t)
      }
      mostrarTexto(div, h.content, h.needsConfirmation)
    }
  }
  const ultimo = (s.historial || []).at(-1)
  if (ultimo && ultimo.role === "assistant" && ultimo.needsConfirmation && s.pendiente) mostrarBanner(s.pendiente.confirmaciones)
}

async function salud() {
  try {
    const r = await fetch("/api/health")
    const j = await r.json()
    estado.textContent = `${j.provider} · ${j.model}${j.configured ? "" : " · sin clave configurada"}`
  } catch {
    estado.textContent = "Servidor no disponible"
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const t = entrada.value
  entrada.value = ""
  entrada.style.height = "auto"
  enviar(t)
})
entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    form.requestSubmit()
  }
})
entrada.addEventListener("input", () => {
  entrada.style.height = "auto"
  entrada.style.height = Math.min(entrada.scrollHeight, 160) + "px"
})
document.querySelectorAll("[data-prompt]").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.prompt)))
$("#confirmar").addEventListener("click", () => enviar("Confirmo"))
$("#cancelar").addEventListener("click", () => enviar("No, no la crees por ahora"))
$("#nueva").addEventListener("click", () => {
  sessionId = nuevoId()
  localStorage.setItem("oc-session", sessionId)
  location.reload()
})

salud()
cargarHistorial()
