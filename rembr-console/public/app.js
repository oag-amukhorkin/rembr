// rembr-console UI. Talks only to this console's /api/* proxy.

const CATEGORY_COLORS = {
  facts: "#4c8dff",
  preferences: "#7dc74f",
  conversations: "#5fa8d3",
  projects: "#9a6bff",
  learning: "#38b26e",
  goals: "#d94f4f",
  context: "#8a97a8",
  reminders: "#d9a824",
  patterns: "#b08b5e",
  decisions: "#f07f3c",
  workflows: "#2fb3c7",
  insights: "#e05fa0",
}

const state = {
  memories: [],
  memoryLimit: 50,
  memoryPage: null,
  totalMemories: null,
  events: [],
  filter: "all",
  selectedId: null,
  live: false,
  graphNodes: [],
  graphEdges: [],
  activeGraphEdges: [],
  graphThreshold: 0.78,
  graphCategories: new Set(),
  graphTodayOnly: false,
  graphView: { x: 0, y: 0, k: 1 },
  graphSelectedId: null,
  graphHoveredId: null,
  graphError: null,
  graphAnimation: null,
  graphFrames: 0,
}

async function call(tool, args) {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  })
  return response.json().catch(() => ({ ok: false, error: "Bad response from console server" }))
}

function parsePayload(payload) {
  if (!payload.ok || !payload.text) return null
  try {
    return JSON.parse(payload.text)
  } catch {
    return null
  }
}

function formatPayload(payload, emptyMessage = "Nothing found.") {
  if (!payload.ok) return `Error: ${payload.error}`
  const parsed = parsePayload(payload)
  if (parsed) return JSON.stringify(parsed, null, 2)
  return payload.text?.trim() || emptyMessage
}

function showOutput(id, payload, emptyMessage) {
  const el = document.getElementById(id)
  el.textContent = formatPayload(payload, emptyMessage)
  el.classList.toggle("error", !payload.ok)
}

function memoriesFromPayload(payload) {
  const parsed = parsePayload(payload)
  if (!parsed) return []
  if (Array.isArray(parsed.data)) return parsed.data
  if (Array.isArray(parsed.memories)) return parsed.memories
  if (Array.isArray(parsed.results)) return parsed.results.map((r) => r.memory ?? r)
  return []
}

function pageFromPayload(payload) {
  const parsed = parsePayload(payload)
  const page = parsed?.metadata?.pagination
  if (!page || typeof page !== "object") return null
  return page
}

function statsFromPayload(payload) {
  const parsed = parsePayload(payload)
  return parsed?.stats ?? parsed
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function formatDate(value) {
  if (!value) return "unknown"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function sourceOf(memory) {
  return memory.metadata?.source ?? memory.metadata?.captured_by ?? "manual"
}

function idOf(memory) {
  return memory.id ?? memory.memory_id ?? ""
}

function contentOf(memory) {
  return memory.content ?? memory.text ?? ""
}

function categoryOf(memory) {
  return memory.category ?? "context"
}

function tagsOf(memory) {
  return Array.isArray(memory.tags) ? memory.tags : []
}

function effectiveDateOf(memory) {
  return memory.metadata?.source_created_at ?? memory.created_at ?? memory.createdAt
}

function isToday(memory) {
  const value = effectiveDateOf(memory)
  if (!value) return false
  return new Date(value).toDateString() === new Date().toDateString()
}

function filteredMemories() {
  if (state.filter === "today") return state.memories.filter(isToday)
  if (state.filter === "distilled") return state.memories.filter((m) => m.metadata?.distilled)
  if (state.filter === "manual") return state.memories.filter((m) => !m.metadata?.distilled)
  if (state.filter.startsWith("cat:")) {
    const category = state.filter.slice(4)
    return state.memories.filter((m) => categoryOf(m) === category)
  }
  return state.memories
}

function setStatus(ok, text) {
  const el = document.getElementById("status")
  el.textContent = text
  el.className = ok ? "status ok" : "status err"
}

function renderStats() {
  const categories = new Set(state.memories.map(categoryOf))
  const distilled = state.memories.filter((m) => m.metadata?.distilled).length
  const today = state.memories.filter(isToday).length
  const sources = new Set(state.memories.map(sourceOf))
  const total = Number.isFinite(Number(state.totalMemories)) ? Number(state.totalMemories) : state.memories.length
  const stats = [
    [total, "memories"],
    [today, "today"],
    [distilled, "distilled"],
    [categories.size, "categories"],
    [sources.size, "sources"],
    [state.events.length, "log events"],
  ]
  document.getElementById("stats-strip").innerHTML = stats
    .map(([value, label]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`)
    .join("")
}

function renderFilters() {
  const counts = new Map()
  for (const memory of state.memories) counts.set(categoryOf(memory), (counts.get(categoryOf(memory)) ?? 0) + 1)
  const filters = [
    ["all", `all ${state.memories.length}`],
    ["today", `today ${state.memories.filter(isToday).length}`],
    ["distilled", `distilled ${state.memories.filter((m) => m.metadata?.distilled).length}`],
    ["manual", `manual ${state.memories.filter((m) => !m.metadata?.distilled).length}`],
    ...[...counts.entries()].sort().map(([category, count]) => [`cat:${category}`, `${category} ${count}`]),
  ]
  const container = document.getElementById("filters")
  container.replaceChildren(...filters.map(([key, label]) => {
    const button = document.createElement("button")
    button.className = `filter ${state.filter === key ? "active" : ""}`
    button.dataset.filter = key
    button.textContent = label
    return button
  }))
  document.querySelectorAll("#filters .filter").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter
      renderAll()
    })
  })
}

function renderFeed() {
  const list = filteredMemories()
  document.getElementById("feed-count").textContent = `${list.length} shown`
  document.getElementById("memory-feed").innerHTML = list
    .map((memory) => {
      const id = idOf(memory)
      const category = categoryOf(memory)
      const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.context
      const tags = tagsOf(memory)
      return `<article class="memory-card ${state.selectedId === id ? "selected" : ""}" data-id="${escapeHtml(id)}">
        <div class="card-head">
          <span class="badge" style="background:${color}">${escapeHtml(category)}</span>
          <span class="source">${escapeHtml(sourceOf(memory))}</span>
          ${memory.metadata?.distilled ? '<span class="mark">distilled</span>' : ""}
          ${isToday(memory) ? '<span class="mark today">today</span>' : ""}
          <time>${escapeHtml(formatDate(effectiveDateOf(memory)))}</time>
        </div>
        <div class="memory-body">${escapeHtml(contentOf(memory))}</div>
        ${tags.length ? `<div class="tags">${tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      </article>`
    })
    .join("")
  document.querySelectorAll(".memory-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.dataset.id
      renderAll()
    })
  })
}

function renderDetail() {
  const memory = state.memories.find((m) => idOf(m) === state.selectedId) ?? filteredMemories()[0]
  if (!memory) {
    document.getElementById("detail").innerHTML = '<p class="muted">No memory selected.</p>'
    return
  }
  state.selectedId = idOf(memory)
  const category = categoryOf(memory)
  const related = state.memories
    .filter((m) => idOf(m) !== idOf(memory))
    .filter((m) => categoryOf(m) === category || tagsOf(m).some((tag) => tagsOf(memory).includes(tag)))
    .slice(0, 6)
  document.getElementById("detail").innerHTML = `
    <span class="badge" style="background:${CATEGORY_COLORS[category] ?? CATEGORY_COLORS.context}">${escapeHtml(category)}</span>
    <h3>${escapeHtml(idOf(memory).slice(0, 12) || "memory")}</h3>
    <p>${escapeHtml(contentOf(memory))}</p>
    <dl>
      <dt>Source</dt><dd>${escapeHtml(sourceOf(memory))}</dd>
      <dt>Effective date</dt><dd>${escapeHtml(formatDate(effectiveDateOf(memory)))}</dd>
      <dt>Tags</dt><dd>${tagsOf(memory).map(escapeHtml).join(", ") || "none"}</dd>
    </dl>
    <h4>Nearby by category/tags</h4>
    <div class="nearby">
      ${related.length ? related.map((m) => `<button data-id="${escapeHtml(idOf(m))}">${escapeHtml(contentOf(m).slice(0, 120))}</button>`).join("") : '<span class="muted">No nearby memories in the current snapshot.</span>'}
    </div>`
  document.querySelectorAll(".nearby button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.id
      renderAll()
    })
  })
}

function renderTimeline() {
  const rows = state.events.slice(-80).reverse()
  document.getElementById("timeline-count").textContent = `${rows.length} recent`
  document.getElementById("timeline").innerHTML = rows.length
    ? rows
        .map((event) => `<div class="timeline-row"><span>${escapeHtml(event.time)}</span><b class="kind-${event.kind}">${escapeHtml(event.kind)}</b><p title="${escapeHtml(event.text)}">${escapeHtml(event.text)}</p></div>`)
        .join("")
    : '<p class="muted">No local capture log events found.</p>'
}

function graphMemories() {
  return state.memories
}

function graphEdgesFromPayload(payload, list) {
  const edges = parsePayload(payload)?.graph?.edges
  if (!Array.isArray(edges)) return []
  const indexes = new Map(list.map((memory, index) => [idOf(memory), index]))
  return edges
    .map((edge) => ({
      a: indexes.get(edge.source),
      b: indexes.get(edge.target),
      similarity: Number(edge.weight),
    }))
    .filter((edge) => Number.isInteger(edge.a) && Number.isInteger(edge.b) && Number.isFinite(edge.similarity))
}

function ensureGraphNodes(list) {
  const previous = new Map(state.graphNodes.map((node) => [idOf(node.memory), node]))
  state.graphNodes = list.map((memory, index) => {
    const id = idOf(memory)
    const existing = previous.get(id)
    if (existing) return { ...existing, memory, index, degree: 0 }
    return {
      index,
      memory,
      x: Math.cos(index * 2.399) * (80 + index * 2.2),
      y: Math.sin(index * 2.399) * (80 + index * 2.2),
      vx: 0,
      vy: 0,
      degree: 0,
    }
  })
}

function visibleGraphNodes() {
  return state.graphNodes.filter((node) => {
    if (state.graphCategories.has(categoryOf(node.memory))) return false
    return !state.graphTodayOnly || isToday(node.memory)
  })
}

function rebuildGraphEdges() {
  const visible = new Set(visibleGraphNodes().map((node) => node.index))
  state.activeGraphEdges = state.graphEdges.filter(
    (edge) => edge.similarity >= state.graphThreshold && visible.has(edge.a) && visible.has(edge.b),
  )
  state.graphNodes.forEach((node) => (node.degree = 0))
  for (const edge of state.activeGraphEdges) {
    state.graphNodes[edge.a].degree += 1
    state.graphNodes[edge.b].degree += 1
  }
}

function tickGraph() {
  const nodes = visibleGraphNodes()
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const n1 = nodes[a]
      const n2 = nodes[b]
      let dx = n2.x - n1.x
      let dy = n2.y - n1.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) d2 = 1
      const force = 900 / d2
      const distance = Math.sqrt(d2)
      dx /= distance
      dy /= distance
      n1.vx -= dx * force
      n1.vy -= dy * force
      n2.vx += dx * force
      n2.vy += dy * force
    }
  }

  for (const edge of state.activeGraphEdges) {
    const n1 = state.graphNodes[edge.a]
    const n2 = state.graphNodes[edge.b]
    let dx = n2.x - n1.x
    let dy = n2.y - n1.y
    const distance = Math.hypot(dx, dy) || 1
    const target = 60 + (0.92 - edge.similarity) * 260
    const force = Math.max(-3, Math.min(3, (distance - target) * 0.012))
    dx /= distance
    dy /= distance
    n1.vx += dx * force
    n1.vy += dy * force
    n2.vx -= dx * force
    n2.vy -= dy * force
  }

  for (const node of nodes) {
    node.vx += -node.x * 0.004
    node.vy += -node.y * 0.004
    if (node.dragging) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx *= 0.85
    node.vy *= 0.85
    node.x += node.vx
    node.y += node.vy
  }
}

function nodeRadius(node) {
  return 4 + Math.min(10, node.degree * 0.9)
}

function linkedTo(a, b) {
  return state.activeGraphEdges.some(
    (edge) =>
      (state.graphNodes[edge.a] === a && state.graphNodes[edge.b] === b) ||
      (state.graphNodes[edge.a] === b && state.graphNodes[edge.b] === a),
  )
}

function graphNodeById(id) {
  return state.graphNodes.find((node) => idOf(node.memory) === id) ?? null
}

function drawGraphCanvas() {
  const canvas = document.getElementById("memory-map")
  const ctx = canvas.getContext("2d")
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const visible = visibleGraphNodes()
  if (!visible.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted")
    ctx.fillText("No memories in this filter.", 20, 30)
    return
  }

  const selected = graphNodeById(state.graphSelectedId)
  const hovered = graphNodeById(state.graphHoveredId)
  const view = state.graphView
  ctx.translate(width / 2 + view.x, height / 2 + view.y)
  ctx.scale(view.k, view.k)
  ctx.lineWidth = 1 / view.k

  for (const edge of state.activeGraphEdges) {
    const n1 = state.graphNodes[edge.a]
    const n2 = state.graphNodes[edge.b]
    const hot = selected && (n1 === selected || n2 === selected)
    ctx.strokeStyle = hot ? "rgba(79,196,176,.75)" : `rgba(140,155,170,${Math.max(0.08, (edge.similarity - 0.6) * 0.5)})`
    ctx.beginPath()
    ctx.moveTo(n1.x, n1.y)
    ctx.lineTo(n2.x, n2.y)
    ctx.stroke()
  }

  for (const node of state.graphNodes) {
    if (!visible.includes(node)) continue
    const radius = nodeRadius(node)
    ctx.globalAlpha = selected && node !== selected && !linkedTo(selected, node) ? 0.25 : 1
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = CATEGORY_COLORS[categoryOf(node.memory)] ?? CATEGORY_COLORS.context
    ctx.fill()
    if (node.memory.metadata?.distilled) {
      ctx.strokeStyle = "#e8eef5"
      ctx.lineWidth = 1.6 / view.k
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + 2.5 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (node === selected || node === hovered) {
      ctx.strokeStyle = CATEGORY_COLORS[categoryOf(node.memory)] ?? CATEGORY_COLORS.context
      ctx.lineWidth = 2 / view.k
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + 4 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  for (const node of [selected, hovered]) {
    if (!node || !visible.includes(node)) continue
    ctx.font = `${11 / view.k}px ui-monospace, Consolas, monospace`
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text")
    const label = contentOf(node.memory).slice(0, 46) + (contentOf(node.memory).length > 46 ? "..." : "")
    ctx.fillText(label, node.x + nodeRadius(node) + 6 / view.k, node.y + 4 / view.k)
  }
}

function pickGraphNode(clientX, clientY) {
  const canvas = document.getElementById("memory-map")
  const rect = canvas.getBoundingClientRect()
  const mx = clientX - rect.left
  const my = clientY - rect.top
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const view = state.graphView
  const x = (mx - width / 2 - view.x) / view.k
  const y = (my - height / 2 - view.y) / view.k
  let best = null
  let bestDistance = Infinity
  for (const node of visibleGraphNodes()) {
    const distance = Math.hypot(node.x - x, node.y - y)
    if (distance < Math.max(10, nodeRadius(node) + 3) && distance < bestDistance) {
      best = node
      bestDistance = distance
    }
  }
  return best
}

function renderGraphDetail(node) {
  const detail = document.getElementById("detail")
  if (!node) {
    detail.innerHTML = state.graphError
      ? `<p class="muted">Graph edges unavailable: ${escapeHtml(state.graphError)}</p>`
      : '<p class="muted">Click a node to inspect it. Drag to reposition, scroll to zoom, drag the background to pan.<br><br>Node size = number of links at the current threshold. Color = category. Ring = distilled/captured by agent.</p>'
    drawGraphCanvas()
    return
  }
  const memory = node.memory
  const category = categoryOf(memory)
  const neighbors = state.activeGraphEdges
    .filter((edge) => state.graphNodes[edge.a] === node || state.graphNodes[edge.b] === node)
    .map((edge) => ({
      node: state.graphNodes[edge.a] === node ? state.graphNodes[edge.b] : state.graphNodes[edge.a],
      similarity: edge.similarity,
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8)
  detail.innerHTML = `
    <span class="badge" style="background:${CATEGORY_COLORS[category] ?? CATEGORY_COLORS.context}">${escapeHtml(category)}</span>
    ${memory.metadata?.distilled ? '<span class="mark" style="margin-left:6px">distilled</span>' : ""}
    ${isToday(memory) ? '<span class="mark today" style="margin-left:6px">today</span>' : ""}
    <p style="margin:12px 0 0">${escapeHtml(contentOf(memory))}</p>
    <div class="meta">${escapeHtml(sourceOf(memory))} · ${escapeHtml(formatDate(effectiveDateOf(memory)))} · ${escapeHtml(idOf(memory).slice(0, 8))}</div>
    ${tagsOf(memory).length ? `<div class="tags" style="margin-top:8px">${tagsOf(memory).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    ${
      neighbors.length
        ? `<div class="nearby"><div class="meta" style="margin:14px 0 6px">nearest (cosine)</div>${neighbors
            .map(
              ({ node: other, similarity }) =>
                `<button data-id="${escapeHtml(idOf(other.memory))}"><span class="sim">${similarity.toFixed(2)}</span>${escapeHtml(contentOf(other.memory).slice(0, 90))}${contentOf(other.memory).length > 90 ? "..." : ""}</button>`,
            )
            .join("")}</div>`
        : ""
    }`
  detail.querySelectorAll(".nearby button").forEach((button) => {
    button.addEventListener("click", () => {
      state.graphSelectedId = button.dataset.id
      state.selectedId = button.dataset.id
      renderGraphDetail(graphNodeById(button.dataset.id))
      drawGraphCanvas()
    })
  })
  drawGraphCanvas()
}

function selectGraphNode(node) {
  state.graphSelectedId = node ? idOf(node.memory) : null
  state.selectedId = state.graphSelectedId
  renderGraphDetail(node)
}

function renderGraph() {
  const list = graphMemories()
  ensureGraphNodes(list)
  rebuildGraphEdges()
  const categoryCounts = new Map()
  for (const memory of state.memories) categoryCounts.set(categoryOf(memory), (categoryCounts.get(categoryOf(memory)) ?? 0) + 1)
  document.getElementById("graph-title").textContent = `Memory Graph ${visibleGraphNodes().length} nodes / ${state.activeGraphEdges.length} links`
  document.getElementById("graph-legend").innerHTML = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `<button class="graph-chip ${state.graphCategories.has(category) ? "off" : ""}" data-category="${escapeHtml(category)}"><i style="background:${CATEGORY_COLORS[category] ?? CATEGORY_COLORS.context}"></i>${escapeHtml(category)} ${count}</button>`)
    .join("")
  document.querySelectorAll(".graph-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const category = button.dataset.category
      if (!category) return
      if (state.graphCategories.has(category)) state.graphCategories.delete(category)
      else state.graphCategories.add(category)
      rebuildGraphEdges()
      renderGraph()
      reheatGraph()
    })
  })
  drawGraphCanvas()
  renderGraphDetail(graphNodeById(state.graphSelectedId))
  reheatGraph()
}

function reheatGraph() {
  state.graphFrames = 0
  if (state.graphAnimation !== null) return
  const loop = () => {
    tickGraph()
    state.graphFrames += 1
    drawGraphCanvas()
    state.graphAnimation = state.graphFrames < 900 ? requestAnimationFrame(loop) : null
  }
  state.graphAnimation = requestAnimationFrame(loop)
}

let graphDragNode = null
let graphPanning = false
let graphPointerStart = { x: 0, y: 0 }
let graphPointerPrev = { x: 0, y: 0 }

document.getElementById("memory-map").addEventListener("pointerdown", (event) => {
  event.currentTarget.setPointerCapture(event.pointerId)
  const node = pickGraphNode(event.clientX, event.clientY)
  if (node) {
    graphDragNode = node
    node.dragging = true
  } else {
    graphPanning = true
  }
  graphPointerStart = { x: event.clientX, y: event.clientY }
  graphPointerPrev = { x: event.clientX, y: event.clientY }
})

document.getElementById("memory-map").addEventListener("pointermove", (event) => {
  const canvas = event.currentTarget
  if (graphDragNode) {
    const rect = canvas.getBoundingClientRect()
    const view = state.graphView
    graphDragNode.x = (event.clientX - rect.left - canvas.clientWidth / 2 - view.x) / view.k
    graphDragNode.y = (event.clientY - rect.top - canvas.clientHeight / 2 - view.y) / view.k
    reheatGraph()
  } else if (graphPanning) {
    state.graphView.x += event.clientX - graphPointerPrev.x
    state.graphView.y += event.clientY - graphPointerPrev.y
    drawGraphCanvas()
  } else {
    const hovered = pickGraphNode(event.clientX, event.clientY)
    const hoveredId = hovered ? idOf(hovered.memory) : null
    if (hoveredId !== state.graphHoveredId) {
      state.graphHoveredId = hoveredId
      canvas.style.cursor = hovered ? "pointer" : "grab"
      drawGraphCanvas()
    }
  }
  graphPointerPrev = { x: event.clientX, y: event.clientY }
})

document.getElementById("memory-map").addEventListener("pointerup", (event) => {
  const distance = Math.hypot(event.clientX - graphPointerStart.x, event.clientY - graphPointerStart.y)
  if (graphDragNode) {
    graphDragNode.dragging = false
    if (distance < 4) selectGraphNode(graphDragNode)
  } else if (graphPanning && distance < 4) {
    selectGraphNode(null)
  }
  graphDragNode = null
  graphPanning = false
})

document.getElementById("memory-map").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault()
    state.graphView.k = Math.min(4, Math.max(0.3, state.graphView.k * (event.deltaY < 0 ? 1.12 : 0.89)))
    drawGraphCanvas()
  },
  { passive: false },
)

function parseEvents(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/)
      if (!match) return null
      const [, time, rest] = match
      let kind = "other"
      if (rest.includes("stored:")) kind = "stored"
      else if (rest.includes("duplicate")) kind = "duplicate"
      else if (rest.includes("debounce")) kind = "debounce"
      else if (rest.includes("injected")) kind = "inject"
      else if (rest.includes("nothing durable")) kind = "nothing"
      return { time, kind, text: rest }
    })
    .filter(Boolean)
}

async function loadCaptureLog() {
  const response = await fetch("/api/capture-log")
  const payload = await response.json().catch(() => ({ ok: false, text: "" }))
  state.events = payload.ok ? parseEvents(payload.text) : []
}

async function loadAll() {
  const [memories, stats] = await Promise.all([
    call("memory", { operation: "list", limit: state.memoryLimit, sort_by: "source_created_at" }),
    call("stats", { operation: "usage" }),
    loadCaptureLog(),
  ])
  if (memories.ok) {
    state.memories = memoriesFromPayload(memories)
    state.memoryPage = pageFromPayload(memories)
    const graph = state.memories.length > 1
      ? await call("graph", {
          operation: "generate",
          memory_ids: state.memories.map(idOf),
          include_relationships: true,
          min_edge_weight: 0.68,
        })
      : { ok: true, text: JSON.stringify({ graph: { edges: [] } }) }
    state.graphEdges = graphEdgesFromPayload(graph, state.memories)
    state.graphError = graph.ok ? null : graph.error
  }
  if (stats.ok) {
    state.totalMemories = statsFromPayload(stats)?.total_memories ?? null
  }
  if (!state.selectedId && state.memories[0]) state.selectedId = idOf(state.memories[0])
  setStatus(memories.ok && stats.ok && !state.graphError, memories.ok && stats.ok && !state.graphError ? "connected" : memories.error || stats.error || state.graphError)
  document.getElementById("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`
  renderAll()
}

function renderAll() {
  renderStats()
  renderFilters()
  renderFeed()
  renderDetail()
  renderTimeline()
  renderGraph()
}

function activateTab(name) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name)
  })
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.id === `tab-${name}`)
  })
}

async function loadContexts() {
  showOutput("contexts-output", await call("context", { operation: "list" }), "No contexts found.")
}

async function loadSnapshots() {
  showOutput("snapshots-output", await call("snapshot", { operation: "list" }), "No snapshots found.")
}

async function loadStats() {
  showOutput("stats-usage", await call("stats", { operation: "usage" }))
  showOutput("stats-embeddings", await call("stats", { operation: "embeddings" }))
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab))
})

document.getElementById("refresh").addEventListener("click", loadAll)
document.getElementById("live").addEventListener("change", (event) => {
  state.live = event.target.checked
})
document.getElementById("link-threshold").addEventListener("input", (event) => {
  state.graphThreshold = Number(event.target.value)
  document.getElementById("link-threshold-value").textContent = state.graphThreshold.toFixed(2)
  rebuildGraphEdges()
  renderGraph()
  reheatGraph()
})
document.getElementById("graph-today").addEventListener("change", (event) => {
  state.graphTodayOnly = event.target.checked
  rebuildGraphEdges()
  renderGraph()
  reheatGraph()
})
document.getElementById("refresh-contexts").addEventListener("click", loadContexts)
document.getElementById("refresh-snapshots").addEventListener("click", loadSnapshots)
document.getElementById("refresh-stats").addEventListener("click", loadStats)

document.getElementById("create-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const content = document.getElementById("create-content").value.trim()
  const category = document.getElementById("create-category").value
  if (!content) return
  const result = await call("memory", { operation: "create", content, category })
  showOutput("create-output", result)
  if (result.ok) {
    document.getElementById("create-content").value = ""
    await loadAll()
  }
})

document.getElementById("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const id = document.getElementById("delete-id").value.trim()
  if (!id) return
  const result = await call("memory", { operation: "delete", id })
  showOutput("delete-output", result)
  if (result.ok) {
    document.getElementById("delete-id").value = ""
    await loadAll()
  }
})

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const query = document.getElementById("search-query").value.trim()
  const mode = document.getElementById("search-mode").value
  if (!query) return
  document.getElementById("search-output").textContent = "Searching..."
  showOutput("search-output", await call("search", { operation: "query", query, search_mode: mode, limit: 20 }), "No matching memories.")
})

setInterval(() => {
  if (state.live) loadAll()
}, 5000)

loadAll()
loadStats()
