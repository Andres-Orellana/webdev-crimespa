<script setup>
import { reactive, ref, computed, onMounted, watch } from 'vue'

/**
 * Uses 3 APIs:
 *  - Leaflet (map + markers)
 *  - Nominatim (geocode + reverse-geocode)
 *  - Your REST API (rest_server.mjs): /codes, /neighborhoods, /incidents, /new-incident, /remove-incident
 *
 * Leaflet (L) is loaded globally from index.html.
 */

const crime_url = ref('http://localhost:8000')
const dialog_err = ref(false)
const initialized = ref(false)

// NEW: prevents "Locate" from triggering a data refresh that changes counts
const suppressNextMoveReload = ref(false)

const ui = reactive({
  locationQuery: '',
  locationStatus: '',
  loadingIncidents: false,
  errorMsg: '',
  successMsg: ''
})

const map = reactive({
  leaflet: null,
  center: {
    lat: 44.955139,
    lng: -93.102222,
    address: ''
  },
  zoom: 12,
  bounds: {
    // St. Paul bounding box
    nw: { lat: 45.008206, lng: -93.217977 },
    se: { lat: 44.883658, lng: -92.993787 }
  },
  districtBoundary: null,
  neighborhood_markers: [
    // District council centers (1..17)
    { id: 1,  location: [44.942068, -93.020521], marker: null },
    { id: 2,  location: [44.977413, -93.025156], marker: null },
    { id: 3,  location: [44.931244, -93.079578], marker: null },
    { id: 4,  location: [44.956192, -93.060189], marker: null },
    { id: 5,  location: [44.978883, -93.068163], marker: null },
    { id: 6,  location: [44.975766, -93.113887], marker: null },
    { id: 7,  location: [44.959639, -93.121271], marker: null },
    { id: 8,  location: [44.947700, -93.128505], marker: null },
    { id: 9,  location: [44.930276, -93.119911], marker: null },
    { id: 10, location: [44.982752, -93.147910], marker: null },
    { id: 11, location: [44.963631, -93.167548], marker: null },
    { id: 12, location: [44.973971, -93.197965], marker: null },
    { id: 13, location: [44.949043, -93.178261], marker: null },
    { id: 14, location: [44.934848, -93.176736], marker: null },
    { id: 15, location: [44.913106, -93.170779], marker: null },
    { id: 16, location: [44.937705, -93.136997], marker: null },
    { id: 17, location: [44.949203, -93.093739], marker: null }
  ],
  selectedIncidentMarker: null
})

const codes = ref([])          // [{code, type}]
const neighborhoods = ref([])  // [{id, name}]
const incidents = ref([])      // API rows with enriched fields
const visibleNeighborhoodIds = ref([]) // neighborhoods currently "visible" in viewport

const filters = reactive({
  selectedIncidentTypes: [],   // incident_type strings
  selectedNeighborhoodIds: [], // neighborhood IDs (optional)
  startDate: '',
  endDate: '',
  limit: 1000
})

// Lookup maps
const codeToType = computed(() => {
  const m = new Map()
  for (const c of codes.value) m.set(c.code, c.type)
  return m
})

const typeToCodes = computed(() => {
  const m = new Map()
  for (const c of codes.value) {
    const arr = m.get(c.type) ?? []
    arr.push(c.code)
    m.set(c.type, arr)
  }
  return m
})

const sortedIncidentTypes = computed(() => {
  const types = Array.from(typeToCodes.value.keys())
  types.sort((a, b) => a.localeCompare(b))
  return types
})

const neighborhoodIdToName = computed(() => {
  const m = new Map()
  for (const n of neighborhoods.value) m.set(n.id, n.name)
  return m
})

// Visible neighborhood filter (rubric requirement)
const finalNeighborhoodFilter = computed(() => {
  const visible = new Set(visibleNeighborhoodIds.value)

  const manual = filters.selectedNeighborhoodIds.length > 0
    ? filters.selectedNeighborhoodIds
    : visibleNeighborhoodIds.value

  // Always intersect with visible
  return manual.filter((id) => visible.has(id))
})

const finalCodeFilter = computed(() => {
  const selected = filters.selectedIncidentTypes
  if (!selected || selected.length === 0) return []
  const out = []
  for (const t of selected) out.push(...(typeToCodes.value.get(t) ?? []))
  return Array.from(new Set(out))
})

// ---------- helpers ----------
function baseUrl() {
  return crime_url.value.replace(/\/+$/, '')
}

async function apiFetch(path, options = {}) {
  ui.errorMsg = ''
  const url = `${baseUrl()}${path}`
  const res = await fetch(url, options)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${txt ? ' - ' + txt : ''}`)
  }
  const ctype = res.headers.get('content-type') || ''
  if (ctype.includes('application/json')) return res.json()
  return res.text()
}

function clampLatLng(lat, lng) {
  const minLat = map.bounds.se.lat
  const maxLat = map.bounds.nw.lat
  const minLng = map.bounds.nw.lng
  const maxLng = map.bounds.se.lng
  return {
    lat: Math.min(Math.max(lat, minLat), maxLat),
    lng: Math.min(Math.max(lng, minLng), maxLng)
  }
}

function parseLatLng(text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null
  return { lat, lng }
}

function nominatimViewboxParam() {
  const left = map.bounds.nw.lng
  const top = map.bounds.nw.lat
  const right = map.bounds.se.lng
  const bottom = map.bounds.se.lat
  return `${left},${top},${right},${bottom}`
}

async function nominatimSearch(query) {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1` +
    `&bounded=1&viewbox=${encodeURIComponent(nominatimViewboxParam())}` +
    `&q=${encodeURIComponent(query)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Nominatim search failed')
  const data = await res.json()
  if (!data || data.length === 0) return null
  return { lat: Number(data[0].lat), lng: Number(data[0].lon), display_name: data[0].display_name }
}

async function nominatimReverse(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lng)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Nominatim reverse failed')
  const data = await res.json()
  if (!data) return null
  return { display_name: data.display_name ?? '' }
}

function inferCategory(incidentType, incidentDetail) {
  const t = `${incidentType ?? ''} ${incidentDetail ?? ''}`.toUpperCase()

  if (t.includes('ASSAULT') || t.includes('ROBBERY') || t.includes('HOMICIDE') || t.includes('RAPE') ||
      t.includes('WEAPON') || t.includes('KIDNAP') || t.includes('DOMESTIC')) return 'violent'

  if (t.includes('BURGLARY') || t.includes('THEFT') || t.includes('VANDAL') || t.includes('ARSON') ||
      t.includes('MOTOR') || t.includes('STOLEN') || t.includes('PROPERTY')) return 'property'

  return 'other'
}

function categoryRowClass(incidentType, incidentDetail) {
  const c = inferCategory(incidentType, incidentDetail)
  if (c === 'violent') return 'crime-violent'
  if (c === 'property') return 'crime-property'
  return 'crime-other'
}

// Replace X only in address number
function normalizeBlock(block) {
  let b = (block ?? '').trim()
  if (!b) return ''
  if (b.includes('&')) return `${b}, Saint Paul, MN`
  b = b.replace(/^(\d+)X(\b)/, '$10$2')
  return `${b}, Saint Paul, MN`
}

const geocodeCache = new Map()

// ---------- Leaflet setup ----------
onMounted(() => {
  map.leaflet = L.map('leafletmap').setView([map.center.lat, map.center.lng], map.zoom)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    minZoom: 11,
    maxZoom: 18
  }).addTo(map.leaflet)

  map.leaflet.setMaxBounds([
    [map.bounds.se.lat, map.bounds.nw.lng],
    [map.bounds.nw.lat, map.bounds.se.lng]
  ])

  // --- Panes so boundaries can't block marker clicks ---
  map.leaflet.createPane('boundaryPane')
  map.leaflet.getPane('boundaryPane').style.zIndex = 200

  map.leaflet.createPane('neighborhoodPane')
  map.leaflet.getPane('neighborhoodPane').style.zIndex = 650

  // District boundaries (NON-interactive so they don't steal clicks)
  map.districtBoundary = L.geoJSON([], {
    pane: 'boundaryPane',
    interactive: false,
    style: { weight: 1, opacity: 0.7, fillOpacity: 0.05 }
  }).addTo(map.leaflet)

  fetch('data/StPaulDistrictCouncil.geojson')
    .then((r) => r.json())
    .then((geo) => geo.features.forEach((f) => map.districtBoundary.addData(f)))
    .catch((e) => console.log('GeoJSON error:', e))

  // Neighborhood markers (popups updated after incident load)
  for (const nm of map.neighborhood_markers) {
    nm.marker = L.circleMarker(nm.location, {
      pane: 'neighborhoodPane',
      radius: 10,
      weight: 1,
      fillOpacity: 0.55
    })
      .addTo(map.leaflet)
      .bindPopup('Loading…')

    nm.marker.on('click', () => nm.marker.openPopup())
  }

  map.leaflet.on('moveend', async () => {
    const c = map.leaflet.getCenter()
    const clamped = clampLatLng(c.lat, c.lng)
    map.center.lat = clamped.lat
    map.center.lng = clamped.lng

    updateVisibleNeighborhoods()

    try {
      const rev = await nominatimReverse(map.center.lat, map.center.lng)
      map.center.address = rev?.display_name ?? ''
      ui.locationQuery = map.center.address || `${map.center.lat.toFixed(5)}, ${map.center.lng.toFixed(5)}`
    } catch {
      ui.locationQuery = `${map.center.lat.toFixed(5)}, ${map.center.lng.toFixed(5)}`
    }

    if (initialized.value) {
      // NEW: if move was caused by "Locate", don't refresh incidents/counts once
      if (suppressNextMoveReload.value) {
        suppressNextMoveReload.value = false
      } else {
        fetchIncidents()
      }
    }
  })
})

// ---------- TODO implementation ----------
async function initializeCrimes() {
  ui.errorMsg = ''
  ui.successMsg = ''
  initialized.value = false

  try {
    codes.value = await apiFetch('/codes')
    neighborhoods.value = await apiFetch('/neighborhoods')

    ui.locationQuery = map.center.address || `${map.center.lat.toFixed(5)}, ${map.center.lng.toFixed(5)}`
    updateVisibleNeighborhoods()
    await fetchIncidents()

    initialized.value = true
  } catch (err) {
    ui.errorMsg = `API initialization failed: ${err.message}`
  }
}

function updateVisibleNeighborhoods() {
  if (!map.leaflet) return
  const b = map.leaflet.getBounds()
  visibleNeighborhoodIds.value = map.neighborhood_markers
    .filter((nm) => b.contains(nm.location))
    .map((nm) => nm.id)
}

async function fetchIncidents() {
  ui.loadingIncidents = true
  ui.errorMsg = ''
  ui.successMsg = ''

  try {
    const params = new URLSearchParams()
    if (filters.startDate) params.set('start_date', filters.startDate)
    if (filters.endDate) params.set('end_date', filters.endDate)

    const codeList = finalCodeFilter.value
    if (codeList.length > 0) {
      params.set('code', codeList.join(','))
      params.set('codes', codeList.join(','))
    }

    const neighList = finalNeighborhoodFilter.value
    if (neighList.length > 0) {
      params.set('neighborhood_number', neighList.join(','))
      params.set('neighborhood', neighList.join(','))
    }

    params.set('limit', String(filters.limit || 1000))

    const rows = await apiFetch(`/incidents?${params.toString()}`)

    incidents.value = rows.map((r) => {
      const incident_type = codeToType.value.get(r.code) ?? String(r.code)
      const neighborhood_name = neighborhoodIdToName.value.get(r.neighborhood_number) ?? String(r.neighborhood_number)
      return { ...r, incident_type, neighborhood_name, category: inferCategory(incident_type, r.incident) }
    })

    // update neighborhood marker popups + size by count
    const counts = new Map()
    for (const it of incidents.value) counts.set(it.neighborhood_number, (counts.get(it.neighborhood_number) ?? 0) + 1)

    for (const nm of map.neighborhood_markers) {
      const name = neighborhoodIdToName.value.get(nm.id) ?? `Neighborhood ${nm.id}`
      const c = counts.get(nm.id) ?? 0
      nm.marker.setPopupContent(`<strong>${name}</strong><br/>Incidents in view: ${c}`)
      nm.marker.setRadius(Math.max(8, Math.min(18, 6 + Math.log10(c + 1) * 10)))
    }
  } catch (err) {
    ui.errorMsg = `Incident load failed: ${err.message}`
  } finally {
    ui.loadingIncidents = false
  }
}

watch(
  () => [
    filters.selectedIncidentTypes,
    filters.selectedNeighborhoodIds,
    filters.startDate,
    filters.endDate,
    filters.limit
  ],
  () => {
    if (initialized.value) fetchIncidents()
  },
  { deep: true }
)

// ---------- location UI ----------
async function goToLocation() {
  ui.locationStatus = ''
  ui.errorMsg = ''
  ui.successMsg = ''

  const text = ui.locationQuery.trim()
  if (!text) return

  const ll = parseLatLng(text)
  if (ll) {
    const clamped = clampLatLng(ll.lat, ll.lng)
    map.leaflet.setView([clamped.lat, clamped.lng], map.leaflet.getZoom())
    ui.locationStatus = 'Moved to clamped coordinates in St. Paul.'
    return
  }

  ui.locationStatus = 'Searching…'
  try {
    const result = await nominatimSearch(text)
    if (!result) {
      ui.locationStatus = 'No result in St. Paul for that search.'
      return
    }
    const clamped = clampLatLng(result.lat, result.lng)
    map.leaflet.setView([clamped.lat, clamped.lng], 15)
    ui.locationQuery = result.display_name
    ui.locationStatus = 'Found!'
  } catch (err) {
    ui.locationStatus = `Search failed: ${err.message}`
  }
}

// ---------- filter UI ----------
function selectAllTypes() {
  filters.selectedIncidentTypes = [...sortedIncidentTypes.value]
}
function clearTypes() {
  filters.selectedIncidentTypes = []
}
function selectAllNeighborhoods() {
  filters.selectedNeighborhoodIds = neighborhoods.value.map((n) => n.id)
}
function clearNeighborhoods() {
  filters.selectedNeighborhoodIds = []
}

// ---------- incident actions ----------
async function deleteIncident(case_number) {
  if (!case_number) return
  ui.errorMsg = ''
  ui.successMsg = ''

  try {
    await apiFetch('/remove-incident', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_number })
    })
    ui.successMsg = `Deleted case ${case_number}.`
    await fetchIncidents()

    if (map.selectedIncidentMarker?.__case_number === case_number) {
      map.leaflet.removeLayer(map.selectedIncidentMarker)
      map.selectedIncidentMarker = null
    }
  } catch (err) {
    ui.errorMsg = `Delete failed: ${err.message}`
  }
}

async function locateIncident(row) {
  ui.errorMsg = ''
  ui.successMsg = ''

  const q = normalizeBlock(row.block)
  if (!q) {
    ui.errorMsg = 'No block/address available for that incident.'
    return
  }

  let geo = geocodeCache.get(q)
  if (!geo) {
    try {
      const result = await nominatimSearch(q)
      if (!result) {
        ui.errorMsg = 'Could not geocode that incident address inside St. Paul.'
        return
      }
      geo = { lat: result.lat, lng: result.lng, display_name: result.display_name }
      geocodeCache.set(q, geo)
    } catch (err) {
      ui.errorMsg = `Geocoding failed: ${err.message}`
      return
    }
  }

  if (map.selectedIncidentMarker) {
    map.leaflet.removeLayer(map.selectedIncidentMarker)
    map.selectedIncidentMarker = null
  }

  const html = `
    <div class="incident-popup">
      <div><strong>${row.date} ${row.time}</strong></div>
      <div>${row.incident_type}</div>
      <div>${row.incident}</div>
      <div>${row.block}</div>
      <button class="button tiny alert" id="popup-del-${row.case_number}">Delete</button>
    </div>
  `

  const marker = L.circleMarker([geo.lat, geo.lng], { radius: 8, weight: 2, fillOpacity: 0.85 })
    .addTo(map.leaflet)
    .bindPopup(html)

  marker.__case_number = row.case_number
  map.selectedIncidentMarker = marker

  // NEW: prevent moveend from reloading data/counts
  suppressNextMoveReload.value = true

  map.leaflet.setView([geo.lat, geo.lng], Math.max(map.leaflet.getZoom(), 16))
  marker.openPopup()

  marker.on('popupopen', () => {
    const btn = document.getElementById(`popup-del-${row.case_number}`)
    if (btn) btn.onclick = () => deleteIncident(row.case_number)
  })
}

// ---------- new incident upload ----------
const newIncident = reactive({
  case_number: '',
  date: '',
  time: '',
  code: '',
  incident: '',
  police_grid: '',
  neighborhood_number: '',
  block: ''
})
const newIncidentErr = ref('')

async function submitNewIncident() {
  newIncidentErr.value = ''
  ui.errorMsg = ''
  ui.successMsg = ''

  const required = [
    ['case_number', newIncident.case_number],
    ['date', newIncident.date],
    ['time', newIncident.time],
    ['code', newIncident.code],
    ['incident', newIncident.incident],
    ['police_grid', newIncident.police_grid],
    ['neighborhood_number', newIncident.neighborhood_number],
    ['block', newIncident.block]
  ]
  const missing = required.filter(([, v]) => String(v ?? '').trim() === '').map(([k]) => k)
  if (missing.length > 0) {
    newIncidentErr.value = `Missing: ${missing.join(', ')}`
    return
  }

  try {
    await apiFetch('/new-incident', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        case_number: String(newIncident.case_number).trim(),
        date: String(newIncident.date).trim(),
        time: String(newIncident.time).trim(),
        code: Number(newIncident.code),
        incident: String(newIncident.incident).trim(),
        police_grid: Number(newIncident.police_grid),
        neighborhood_number: Number(newIncident.neighborhood_number),
        block: String(newIncident.block).trim()
      })
    })

    ui.successMsg = 'New incident uploaded.'
    newIncident.case_number = ''
    newIncident.incident = ''
    newIncident.block = ''
    await fetchIncidents()
  } catch (err) {
    ui.errorMsg = `Upload failed: ${err.message}`
  }
}

// dialog OK
function closeDialog() {
  const dialog = document.getElementById('rest-dialog')
  const url_input = document.getElementById('dialog-url')

  if (crime_url.value !== '' && url_input.checkValidity()) {
    dialog_err.value = false
    dialog.close()
    initializeCrimes()
  } else {
    dialog_err.value = true
  }
}
</script>

<template>
  <dialog id="rest-dialog" open>
    <h1 class="dialog-header">St. Paul Crime REST API</h1>
    <label class="dialog-label">URL: </label>
    <input id="dialog-url" class="dialog-input" type="url" v-model="crime_url" placeholder="http://localhost:8000" />
    <p class="dialog-error" v-if="dialog_err">Error: must enter valid URL</p>
    <br />
    <button class="button" type="button" @click="closeDialog">OK</button>
  </dialog>

  <div class="top-bar app-topbar">
    <div class="top-bar-left">
      <ul class="dropdown menu" data-dropdown-menu>
        <li class="menu-text">St. Paul Crime Map</li>
        <li><a href="about.html">About the project</a></li>
      </ul>
    </div>
  </div>

  <div class="grid-container app-shell">
    <div class="grid-x grid-padding-x grid-padding-y">
      <!-- Map -->
      <div class="cell small-12 medium-7">
        <div class="callout">
          <label class="location-label">
            Location (address or lat,lng)
            <div class="input-group">
              <input class="input-group-field" type="text" v-model="ui.locationQuery"
                     placeholder="e.g., 44.9551, -93.1022 or Macalester College" />
              <div class="input-group-button">
                <button class="button" type="button" @click="goToLocation">Go</button>
              </div>
            </div>
          </label>

          <p class="help-text" v-if="ui.locationStatus">{{ ui.locationStatus }}</p>
          <p class="help-text">Map center: {{ map.center.lat.toFixed(5) }}, {{ map.center.lng.toFixed(5) }}</p>

          <div id="leafletmap"></div>

          <p class="help-text map-help">
            Tip: panning/zooming updates the input and refreshes incidents for neighborhoods currently in view.
          </p>
        </div>
      </div>

      <!-- Filters + Upload -->
      <div class="cell small-12 medium-5">
        <div class="callout">
          <h5>Filters</h5>

          <div class="grid-x grid-padding-x">
            <div class="cell small-6">
              <label>Start date
                <input type="date" v-model="filters.startDate" />
              </label>
            </div>
            <div class="cell small-6">
              <label>End date
                <input type="date" v-model="filters.endDate" />
              </label>
            </div>
          </div>

          <label>Max incidents
            <input type="number" min="1" max="5000" v-model.number="filters.limit" />
          </label>

          <button class="button small" type="button" @click="fetchIncidents" :disabled="ui.loadingIncidents || !initialized">
            Update crimes
          </button>

          <span class="label secondary" v-if="ui.loadingIncidents">Loading…</span>
          <span class="label success" v-if="ui.successMsg">{{ ui.successMsg }}</span>
          <span class="label alert" v-if="ui.errorMsg">{{ ui.errorMsg }}</span>

          <hr />

          <div class="filter-section">
            <div class="filter-title">
              <strong>incident_type</strong>
              <span class="filter-actions">
                <button class="button tiny" type="button" @click="selectAllTypes">All</button>
                <button class="button tiny secondary" type="button" @click="clearTypes">None</button>
              </span>
            </div>
            <div class="filter-list">
              <label v-for="t in sortedIncidentTypes" :key="t" class="checkbox-line">
                <input type="checkbox" :value="t" v-model="filters.selectedIncidentTypes" />
                {{ t }}
              </label>
            </div>
            <p class="help-text">If none selected, all incident types are included.</p>
          </div>

          <hr />

          <div class="filter-section">
            <div class="filter-title">
              <strong>neighborhood_name</strong>
              <span class="filter-actions">
                <button class="button tiny" type="button" @click="selectAllNeighborhoods">All</button>
                <button class="button tiny secondary" type="button" @click="clearNeighborhoods">None</button>
              </span>
            </div>
            <div class="filter-list">
              <label v-for="n in neighborhoods" :key="n.id" class="checkbox-line">
                <input type="checkbox" :value="n.id" v-model="filters.selectedNeighborhoodIds" />
                {{ n.name }}
              </label>
            </div>
            <p class="help-text">
              If none selected, neighborhoods come from what's visible on the map. Results are always limited to visible neighborhoods.
            </p>
          </div>

          <hr />

          <h5>New Incident Upload</h5>
          <p class="help-text">All fields are required.</p>
          <p class="label alert" v-if="newIncidentErr">{{ newIncidentErr }}</p>

          <label>Case number
            <input type="text" v-model="newIncident.case_number" placeholder="e.g., 19245020" />
          </label>

          <div class="grid-x grid-padding-x">
            <div class="cell small-6">
              <label>Date
                <input type="date" v-model="newIncident.date" />
              </label>
            </div>
            <div class="cell small-6">
              <label>Time
                <input type="time" step="1" v-model="newIncident.time" />
              </label>
            </div>
          </div>

          <label>Incident code
            <select v-model="newIncident.code">
              <option value="" disabled>Select a code…</option>
              <option v-for="c in codes" :key="c.code" :value="c.code">
                {{ c.code }} - {{ c.type }}
              </option>
            </select>
          </label>

          <label>Incident description
            <input type="text" v-model="newIncident.incident" placeholder="More specific than incident_type" />
          </label>

          <div class="grid-x grid-padding-x">
            <div class="cell small-6">
              <label>Police grid
                <input type="number" v-model="newIncident.police_grid" />
              </label>
            </div>
            <div class="cell small-6">
              <label>Neighborhood
                <select v-model="newIncident.neighborhood_number">
                  <option value="" disabled>Select…</option>
                  <option v-for="n in neighborhoods" :key="n.id" :value="n.id">{{ n.name }}</option>
                </select>
              </label>
            </div>
          </div>

          <label>Block (approx. address)
            <input type="text" v-model="newIncident.block" placeholder="e.g., 98X UNIVERSITY AV W" />
          </label>

          <button class="button warning" type="button" @click="submitNewIncident" :disabled="!initialized">
            Submit new incident
          </button>
        </div>
      </div>

      <!-- Table -->
      <div class="cell small-12">
        <div class="callout">
          <div class="grid-x grid-padding-x align-middle">
            <div class="cell small-12 medium-6">
              <h5>Incidents (most recent first)</h5>
              <p class="help-text">Showing {{ incidents.length }} incidents. Neighborhood markers show “Incidents in view”.</p>
            </div>
            <div class="cell small-12 medium-6">
              <div class="legend">
                <span class="legend-item legend-violent">Violent</span>
                <span class="legend-item legend-property">Property</span>
                <span class="legend-item legend-other">Other</span>
              </div>
            </div>
          </div>

          <div class="table-scroll">
            <table class="hover stack">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Incident Type</th>
                  <th>Incident</th>
                  <th>Neighborhood</th>
                  <th>Block</th>
                  <th style="width: 12rem;">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in incidents" :key="r.case_number" :class="categoryRowClass(r.incident_type, r.incident)">
                  <td>{{ r.date }}</td>
                  <td>{{ r.time }}</td>
                  <td>{{ r.incident_type }}</td>
                  <td>{{ r.incident }}</td>
                  <td>{{ r.neighborhood_name }}</td>
                  <td>{{ r.block }}</td>
                  <td>
                    <button class="button tiny" type="button" @click="locateIncident(r)">Locate</button>
                    <button class="button tiny alert" type="button" @click="deleteIncident(r.case_number)">Delete</button>
                  </td>
                </tr>
                <tr v-if="incidents.length === 0">
                  <td colspan="7">No incidents match current filters (and visible neighborhoods).</td>
                </tr>
              </tbody>
            </table>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
#rest-dialog {
  width: 22rem;
  margin-top: 1rem;
  z-index: 1000;
}

#leafletmap {
  height: 520px;
  width: 100%;
  border-radius: 0.25rem;
}

.dialog-header {
  font-size: 1.2rem;
  font-weight: 700;
}

.dialog-label {
  font-size: 1rem;
}

.dialog-input {
  font-size: 1rem;
  width: 100%;
}

.dialog-error {
  font-size: 1rem;
  color: #D32323;
}

.app-topbar {
  margin-bottom: 0.5rem;
}

.map-help {
  margin-top: 0.5rem;
}

.filter-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.filter-actions {
  display: flex;
  gap: 0.25rem;
}

.filter-list {
  max-height: 180px;
  overflow: auto;
  border: 1px solid #e6e6e6;
  padding: 0.5rem;
  border-radius: 0.25rem;
}

.checkbox-line {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.25rem;
}

.table-scroll {
  overflow-x: auto;
}

.legend {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.legend-item {
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
}
</style>
