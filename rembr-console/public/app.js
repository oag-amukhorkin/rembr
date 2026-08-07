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

const CLUSTER_COLORS = ["#58c6b5", "#6fa8ff", "#aa86ff", "#e88961", "#e2b84f", "#5fc785", "#d875a5", "#75b9d1"]

const state = {
  memories: [],
  memoryLimit: 300,
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
  graphFilter: "",
  graphView: { x: 0, y: 0, k: 1 },
  graphFitScale: 1,
  graphSelectedId: null,
  graphHoveredId: null,
  graphError: null,
  graphAnimation: null,
  graphFrames: 0,
  graphMode: "semantic",
  graphMemories: [],
  graphCategory: null,
  graphCategoryTotals: {},
  graphClusters: [],
  graphHoveredCategory: null,
  graphCluster: null,
  graphClusterLinks: [],
  graphBreadcrumbs: [],
  graphHierarchyLoaded: false,
  graphLoading: false,
  graphTotalChildren: 0,
  graphRequest: 0,
}

// Keep the browser-to-console bearer token in this page process only. A reload
// deliberately requires re-entry so browser storage cannot persist it.
let consoleToken = ""

function currentToken() {
  return consoleToken
}

async function call(tool, args) {
  const token = currentToken()
  if (!token) return { ok: false, error: "Enter the console access token" }
  const response = await fetch("/api/call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, args }),
    credentials: "same-origin",
    redirect: "error",
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
  return state.graphMemories
}

function clusterColor(cluster) {
  let hash = 0
  for (const char of cluster.id ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0
  return CLUSTER_COLORS[Math.abs(hash) % CLUSTER_COLORS.length]
}

function positionGraphClusters(clusters, links) {
  const maxCount = Math.max(1, ...clusters.map((cluster) => Number(cluster.memory_count)))
  const radius = Math.max(120, clusters.length * 28)
  const positioned = clusters.map((cluster, index) => ({
    ...cluster,
    count: Number(cluster.memory_count),
    radius: 38 + Math.sqrt(Number(cluster.memory_count) / maxCount) * 50,
    x: Math.cos((index / clusters.length) * Math.PI * 2 - Math.PI / 2) * radius,
    y: Math.sin((index / clusters.length) * Math.PI * 2 - Math.PI / 2) * radius,
  }))
  const byId = new Map(positioned.map((cluster) => [cluster.id, cluster]))
  for (let iteration = 0; iteration < 120; iteration++) {
    for (const link of links) {
      const a = byId.get(link.source)
      const b = byId.get(link.target)
      if (!a || !b || Number(link.similarity) < 0.5) continue
      const pull = (Number(link.similarity) - 0.5) * 0.005
      const dx = b.x - a.x
      const dy = b.y - a.y
      a.x += dx * pull
      a.y += dy * pull
      b.x -= dx * pull
      b.y -= dy * pull
    }
    for (let left = 0; left < positioned.length; left++) {
      for (let right = left + 1; right < positioned.length; right++) {
        const a = positioned[left]
        const b = positioned[right]
        let dx = b.x - a.x
        let dy = b.y - a.y
        const distance = Math.hypot(dx, dy) || 1
        const minimum = a.radius + b.radius + 20
        if (distance < minimum) {
          const shift = (minimum - distance) * 0.22
          dx /= distance
          dy /= distance
          a.x -= dx * shift
          a.y -= dy * shift
          b.x += dx * shift
          b.y += dy * shift
        }
      }
    }
    for (const cluster of positioned) {
      cluster.x *= 0.997
      cluster.y *= 0.997
    }
  }
  state.graphClusters = positioned
}

function graphClusterById(id) {
  return state.graphClusters.find((cluster) => cluster.id === id) ?? null
}

function visibleGraphClusters() {
  return state.graphClusters
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
    if (state.graphTodayOnly && !isToday(node.memory)) return false
    return true
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

function wrappedClusterLabel(ctx, label, maxWidth) {
  const words = label.split(/\s+/).filter(Boolean)
  const lines = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  const visible = lines.length <= 2 ? lines : [lines[0], lines.slice(1).join(" ")]
  return visible.map(value => {
    if (ctx.measureText(value).width <= maxWidth) return value
    let fitted = value
    while (fitted.length > 3 && ctx.measureText(`${fitted}...`).width > maxWidth) fitted = fitted.slice(0, -1)
    return `${fitted}...`
  })
}

function drawSemanticClusters(ctx, width, height) {
  const clusters = visibleGraphClusters()
  if (!clusters.length) {
    state.graphFitScale = 1
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted")
    ctx.fillText("No topics match this filter.", 20, 30)
    return
  }
  const view = state.graphView
  const bounds = clusters.reduce((result, cluster) => ({
    minX: Math.min(result.minX, cluster.x - cluster.radius),
    maxX: Math.max(result.maxX, cluster.x + cluster.radius),
    minY: Math.min(result.minY, cluster.y - cluster.radius),
    maxY: Math.max(result.maxY, cluster.y + cluster.radius),
  }), { minX: 0, maxX: 0, minY: 0, maxY: 0 })
  const fitScale = clusters.length
    ? Math.min(1, (width - 24) / Math.max(1, bounds.maxX - bounds.minX), (height - 24) / Math.max(1, bounds.maxY - bounds.minY))
    : 1
  state.graphFitScale = fitScale
  const scale = view.k * fitScale
  ctx.translate(width / 2 + view.x, height / 2 + view.y)
  ctx.scale(scale, scale)

  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]))
  for (const link of state.graphClusterLinks) {
    const source = byId.get(link.source)
    const target = byId.get(link.target)
    if (!source || !target) continue
    ctx.strokeStyle = `rgba(111,168,255,${Math.max(0.05, (Number(link.similarity) - 0.35) * 0.45)})`
    ctx.lineWidth = 1 / scale
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()
  }

  for (const cluster of clusters) {
    const hovered = cluster.id === state.graphHoveredCategory
    ctx.globalAlpha = hovered ? 1 : 0.88
    ctx.beginPath()
    ctx.arc(cluster.x, cluster.y, cluster.radius, 0, Math.PI * 2)
    ctx.fillStyle = clusterColor(cluster)
    ctx.fill()
    if (hovered) {
      ctx.strokeStyle = "#e8eef5"
      ctx.lineWidth = 2 / scale
      ctx.stroke()
    }

    ctx.globalAlpha = 1
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = "#10151d"
    ctx.font = `${Math.max(10, Math.min(15, cluster.radius / 4)) / scale}px ui-monospace, Consolas, monospace`
    const lines = wrappedClusterLabel(ctx, cluster.label, cluster.radius * 1.5)
    const labelStart = cluster.y - (lines.length === 2 ? 13 : 7) / scale
    lines.forEach((line, index) => ctx.fillText(line, cluster.x, labelStart + index * 15 / scale))
    ctx.font = `600 ${Math.max(11, Math.min(17, cluster.radius / 3.4)) / scale}px ui-monospace, Consolas, monospace`
    ctx.fillText(cluster.memory_count.toLocaleString(), cluster.x, cluster.y + (lines.length === 2 ? 22 : 13) / scale)
  }
  ctx.textAlign = "start"
  ctx.textBaseline = "alphabetic"
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

  if (state.graphMode === "semantic") {
    drawSemanticClusters(ctx, width, height)
    return
  }

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
    ctx.strokeStyle = hot ? "rgba(79,196,176,.85)" : `rgba(140,155,170,${Math.max(0.2, (edge.similarity - 0.6) * 0.75)})`
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
  const scale = state.graphMode === "semantic" ? view.k * state.graphFitScale : view.k
  const x = (mx - width / 2 - view.x) / scale
  const y = (my - height / 2 - view.y) / scale
  if (state.graphMode === "semantic") {
    return visibleGraphClusters().find((cluster) => Math.hypot(cluster.x - x, cluster.y - y) <= cluster.radius) ?? null
  }
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
    detail.innerHTML = `<button class="graph-overview">All topics</button>${state.graphError
      ? `<p class="muted">Graph edges unavailable: ${escapeHtml(state.graphError)}</p>`
      : '<p class="muted">Click a node to inspect it. Drag to reposition, scroll to zoom, drag the background to pan.<br><br>Node size = number of links at the current threshold. Color = category.</p>'}`
    detail.querySelector(".graph-overview").addEventListener("click", showGraphOverview)
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
    <button class="graph-overview">All topics</button>
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
  detail.querySelector(".graph-overview").addEventListener("click", showGraphOverview)
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

function renderGraphOverviewDetail(cluster) {
  const detail = document.getElementById("detail")
  if (state.graphLoading) {
    detail.innerHTML = '<p class="muted">Building semantic topics...</p>'
    return
  }
  if (!cluster) {
    detail.innerHTML = '<p class="muted">Every embedded memory is represented through cross-category semantic topics.<br><br>Click a bubble or zoom into it to reveal narrower topics. Leaf topics open their individual memories and cosine links. Zoom out to move up.</p>'
    return
  }
  const categories = Object.entries(cluster.category_counts ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4)
  const total = Number(cluster.total_memory_count ?? cluster.memory_count)
  const countText = state.graphFilter
    ? `${cluster.memory_count.toLocaleString()} matching memories out of ${total.toLocaleString()} in this topic.`
    : `${total.toLocaleString()} semantically related memories across categories.`
  detail.innerHTML = `
    <span class="topic-dot" style="background:${clusterColor(cluster)}"></span>
    <h3>${escapeHtml(cluster.label)}</h3>
    <p>${countText}</p>
    <div class="topic-composition">${categories.map(([category, count]) => `<span>${escapeHtml(category)} ${Number(count).toLocaleString()}</span>`).join("")}</div>
    <p class="muted">${cluster.is_leaf ? "Click to reveal individual memories." : "Click or zoom in to reveal narrower topics."}</p>`
}

function selectGraphNode(node) {
  if (state.graphMode === "semantic") {
    if (node) loadSemanticCluster(node.id)
    return
  }
  state.graphSelectedId = node ? idOf(node.memory) : null
  state.selectedId = state.graphSelectedId
  renderGraphDetail(node)
}

function renderGraph() {
  const threshold = document.getElementById("link-threshold")
  const today = document.getElementById("graph-today")
  const options = document.querySelector(".graph-options")
  if (state.graphMode === "semantic") {
    threshold.disabled = true
    today.disabled = true
    options.classList.add("disabled")
    const cluster = state.graphCluster
    const totalMemories = Number(cluster?.total_memory_count ?? cluster?.memory_count ?? 0)
    const memoryCount = state.graphFilter
      ? `${Number(cluster?.memory_count ?? 0).toLocaleString()} of ${totalMemories.toLocaleString()} matching memories`
      : `${totalMemories.toLocaleString()} memories`
    const topicCount = state.graphFilter
      ? `${state.graphClusters.length} of ${state.graphTotalChildren} topics`
      : `${state.graphClusters.length} topics`
    document.getElementById("graph-title").textContent = cluster
      ? `Memory Map / ${cluster.label} / ${memoryCount} / ${topicCount}`
      : "Memory Map / loading semantic topics"
    document.getElementById("graph-legend").innerHTML = state.graphBreadcrumbs
      .map((crumb) => `<button class="graph-chip breadcrumb ${crumb.id === cluster?.id ? "current" : ""}" data-cluster-id="${escapeHtml(crumb.id)}">${escapeHtml(crumb.level === 0 ? "all topics" : crumb.label)}</button>`)
      .join("")
    document.querySelectorAll(".graph-chip[data-cluster-id]").forEach((button) => {
      button.addEventListener("click", () => loadSemanticCluster(button.dataset.clusterId))
    })
    drawGraphCanvas()
    renderGraphOverviewDetail(graphClusterById(state.graphHoveredCategory))
    return
  }

  threshold.disabled = false
  today.disabled = false
  options.classList.remove("disabled")
  const list = graphMemories()
  ensureGraphNodes(list)
  rebuildGraphEdges()
  const categoryCounts = new Map()
  for (const memory of list) categoryCounts.set(categoryOf(memory), (categoryCounts.get(categoryOf(memory)) ?? 0) + 1)
  const clusterTotal = Number(state.graphCluster?.total_memory_count ?? state.graphCluster?.memory_count ?? list.length)
  document.getElementById("graph-title").textContent = `${state.graphCluster?.label ?? "Topic"} ${visibleGraphNodes().length} of ${clusterTotal.toLocaleString()} memories / ${state.activeGraphEdges.length} links`
  const breadcrumbs = state.graphBreadcrumbs
    .map((crumb) => `<button class="graph-chip breadcrumb" data-cluster-id="${escapeHtml(crumb.id)}">${escapeHtml(crumb.level === 0 ? "all topics" : crumb.label)}</button>`)
    .join("")
  document.getElementById("graph-legend").innerHTML = breadcrumbs + [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `<button class="graph-chip ${state.graphCategories.has(category) ? "off" : ""}" data-category="${escapeHtml(category)}"><i style="background:${CATEGORY_COLORS[category] ?? CATEGORY_COLORS.context}"></i>${escapeHtml(category)} ${count}</button>`)
    .join("")
  document.querySelectorAll(".graph-chip").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.clusterId) {
        loadSemanticCluster(button.dataset.clusterId)
        return
      }
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

function showGraphOverview() {
  loadSemanticCluster()
}

async function loadSemanticCluster(clusterId) {
  const request = ++state.graphRequest
  state.graphLoading = true
  if (state.graphAnimation !== null) {
    cancelAnimationFrame(state.graphAnimation)
    state.graphAnimation = null
  }
  renderGraphOverviewDetail(null)
  const result = await call("graph", {
    operation: "generate",
    cluster_algorithm: "semantic",
    ...(clusterId ? { cluster_id: clusterId } : {}),
    ...(state.graphFilter ? { filter_query: state.graphFilter } : {}),
    min_edge_weight: 0.68,
  })
  if (request !== state.graphRequest) return
  const hierarchy = parsePayload(result)?.semantic_hierarchy
  if (!result.ok || !hierarchy) {
    state.graphLoading = false
    state.graphError = result.error ?? "Semantic hierarchy was not returned"
    if (clusterId) {
      await loadSemanticCluster()
      return
    }
    renderGraphOverviewDetail(null)
    return
  }

  const list = Array.isArray(hierarchy.memories) ? hierarchy.memories : []
  state.graphMemories = list
  state.graphCluster = hierarchy.cluster
  state.graphBreadcrumbs = Array.isArray(hierarchy.breadcrumbs) ? hierarchy.breadcrumbs : []
  state.graphClusterLinks = Array.isArray(hierarchy.links) ? hierarchy.links : []
  state.graphTotalChildren = Number(hierarchy.total_children ?? hierarchy.children?.length ?? 0)
  state.graphEdges = graphEdgesFromPayload({ ok: true, text: JSON.stringify({ graph: { edges: hierarchy.edges ?? [] } }) }, list)
  state.graphError = null
  state.graphMode = hierarchy.cluster?.is_leaf ? "memories" : "semantic"
  positionGraphClusters(Array.isArray(hierarchy.children) ? hierarchy.children : [], state.graphClusterLinks)
  state.graphSelectedId = null
  state.graphHoveredId = null
  state.graphHoveredCategory = null
  state.graphCategories.clear()
  state.graphView = { x: 0, y: 0, k: 1 }
  state.graphLoading = false
  state.graphHierarchyLoaded = true
  renderGraph()
}

function reheatGraph() {
  if (state.graphMode === "semantic") {
    drawGraphCanvas()
    return
  }
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
    const scale = state.graphMode === "semantic" ? view.k * state.graphFitScale : view.k
    graphDragNode.x = (event.clientX - rect.left - canvas.clientWidth / 2 - view.x) / scale
    graphDragNode.y = (event.clientY - rect.top - canvas.clientHeight / 2 - view.y) / scale
    reheatGraph()
  } else if (graphPanning) {
    state.graphView.x += event.clientX - graphPointerPrev.x
    state.graphView.y += event.clientY - graphPointerPrev.y
    drawGraphCanvas()
  } else {
    const hovered = pickGraphNode(event.clientX, event.clientY)
    if (state.graphMode === "semantic") {
      const clusterId = hovered?.id ?? null
      if (clusterId !== state.graphHoveredCategory) {
        state.graphHoveredCategory = clusterId
        canvas.style.cursor = hovered ? "pointer" : "grab"
        renderGraphOverviewDetail(hovered)
        drawGraphCanvas()
      }
    } else {
      const hoveredId = hovered ? idOf(hovered.memory) : null
      if (hoveredId !== state.graphHoveredId) {
        state.graphHoveredId = hoveredId
        canvas.style.cursor = hovered ? "pointer" : "grab"
        drawGraphCanvas()
      }
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
    if (state.graphMode === "semantic" && event.deltaY < 0 && state.graphView.k >= 2.15) {
      const hovered = graphClusterById(state.graphHoveredCategory)
      if (hovered && !state.graphLoading) {
        loadSemanticCluster(hovered.id)
        return
      }
    }
    if (event.deltaY > 0 && state.graphView.k <= 0.45 && state.graphBreadcrumbs.length > 1 && !state.graphLoading) {
      loadSemanticCluster(state.graphBreadcrumbs.at(-2).id)
      return
    }
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
  const token = currentToken()
  if (!token) {
    state.events = []
    return
  }
  const response = await fetch("/api/capture-log", {
    headers: { authorization: `Bearer ${token}` },
    credentials: "same-origin",
    redirect: "error",
  })
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
  }
  if (stats.ok) {
    const parsedStats = statsFromPayload(stats)
    state.totalMemories = parsedStats?.total_memories ?? null
    state.graphCategoryTotals = parsedStats?.by_category ?? {}
  }
  if (!state.selectedId && state.memories[0]) state.selectedId = idOf(state.memories[0])
  setStatus(memories.ok && stats.ok, memories.ok && stats.ok ? "connected" : memories.error || stats.error)
  document.getElementById("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`
  renderAll()
  const currentClusterId = state.graphHierarchyLoaded ? state.graphCluster?.id : undefined
  await loadSemanticCluster(currentClusterId)
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
let graphFilterTimer = null
document.getElementById("graph-filter").addEventListener("input", (event) => {
  state.graphFilter = event.target.value.trim()
  clearTimeout(graphFilterTimer)
  graphFilterTimer = setTimeout(() => loadSemanticCluster(state.graphCluster?.id), 250)
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
window.addEventListener("resize", drawGraphCanvas)

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

document.getElementById("connect-console").addEventListener("click", () => {
  const input = document.getElementById("console-token")
  const token = input.value.trim()
  input.value = ""
  if (token) consoleToken = token
  loadAll()
  loadStats()
})
document.getElementById("forget-console").addEventListener("click", () => {
  consoleToken = ""
  state.memories = []
  state.events = []
  state.graphEdges = []
  renderAll()
  const status = document.getElementById("status")
  status.textContent = "authentication required"
  status.className = "status"
})
document.getElementById("console-token").addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("connect-console").click()
})

setInterval(() => {
  if (state.live) loadAll()
}, 5000)

if (currentToken()) {
  loadAll()
  loadStats()
} else {
  const status = document.getElementById("status")
  status.textContent = "authentication required"
  status.className = "status"
}
