'use strict';

// === Constants ===
const VALID_TIME_RANGES = [0, 7, 14, 30, 60, 90, 120, 240, 365];

const VALID_LINE_TYPES = ['raw', '7', '30', '90'];
const DEFAULT_TIME_RANGE = 30;
const DEFAULT_LINE_TYPE = '7';
const STORAGE_KEY = 'oscar-timing-selection';
const LEGACY_STORAGE_KEY = 'julia-ci-timing-config';
const AGO_UPDATE_INTERVAL = 60 * 1000;
const STALE_DATA_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
const TREND_MIN_POINTS = 3;

// All mutable application state lives here so dependencies remain explicit.
const app = {
    chart: null,
    timingData: null,
    selectedJobs: new Set(),
    jobFilter: '',
    juliaVersion: 'all',
    filterTimer: null,
    timeRangeDays: DEFAULT_TIME_RANGE,
    lineType: DEFAULT_LINE_TYPE,
    colors: {},
    jobInfo: new Map(),
    jobIds: new Map(),
    jobsById: new Map(),
    jobNames: [],
    stats: { column: 'median', ascending: false, rangeKey: '', cache: new Map() },
    zoom: { xMin: null, xMax: null, yMin: null, yMax: null },
    regressionLine: null,
    trendCell: null,
    highlightedRow: null,
    highlightActive: false
};

// === Helper Functions ===

function setJuliaVersion(version) {
    app.juliaVersion = version;
    updateChart();
    updateStatsTable();
    updateURL();
}

function refreshAllUI() {
    updateJuliaVersionFilterUI();
    updateChart();
    updateStatsTable();
}

function refreshChartAfterSelectionChange() {
    // Keep checkbox clicks responsive: do not rebuild the stats table here.
    // The browser can paint the native checkbox state first; the expensive
    // chart update is scheduled for the next animation frame.
    clearChartHighlight();
    clearStatsRowHighlight();
    hideRegressionLine();
    app.trendCell = null;
    syncStatsSelectAllCheckbox();
    updateURL();
    requestAnimationFrame(updateChart);
}

function toggleStatsJob(jobName, checked) {
    if (checked) {
        app.selectedJobs.add(jobName);
    } else {
        app.selectedJobs.delete(jobName);
    }
    refreshChartAfterSelectionChange();
}

function toggleAllVisibleStatsJobs(checked) {
    for (const name of getVisibleJobNames()) {
        if (checked) {
            app.selectedJobs.add(name);
        } else {
            app.selectedJobs.delete(name);
        }
    }
    document.querySelectorAll('.stats-job-checkbox').forEach(checkbox => {
        checkbox.checked = checked;
    });
    refreshChartAfterSelectionChange();
}

function syncStatsSelectAllCheckbox() {
    const checkbox = document.getElementById('stats-select-all');
    if (!checkbox) return;
    const visible = getVisibleJobNames();
    const selectedVisible = visible.filter(name => app.selectedJobs.has(name)).length;
    checkbox.checked = visible.length > 0 && selectedVisible === visible.length;
    checkbox.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
}

// Buildkite emoji mapping - use their actual images
const BUILDKITE_EMOJI_BASE = 'https://buildkiteassets.com/emojis/img-buildkite-64';
const emojiImageMap = {
    ':macos:': `${BUILDKITE_EMOJI_BASE}/mac.png`,
    ':apple:': `${BUILDKITE_EMOJI_BASE}/mac.png`,
    ':mac:': `${BUILDKITE_EMOJI_BASE}/mac.png`,
    ':linux:': `${BUILDKITE_EMOJI_BASE}/linux.png`,
    ':windows:': `${BUILDKITE_EMOJI_BASE}/windows.png`,
    ':freebsd:': `${BUILDKITE_EMOJI_BASE}/freebsd.png`,
};
const emojiMap = {
    ':rocket:': '🚀',
    ':gear:': '⚙️',
    ':package:': '📦',
    ':test_tube:': '🧪',
    ':memo:': '📝',
    ':lock:': '🔒',
    ':key:': '🔑',
    ':warning:': '⚠️',
    ':x:': '❌',
    ':white_check_mark:': '✅',
    ':hourglass:': '⏳',
    ':zap:': '⚡',
};

// Unicode fallbacks for canvas/tooltip contexts that can't render HTML
const emojiTextMap = {
    ':macos:': '🍎',
    ':apple:': '🍎',
    ':mac:': '🍎',
    ':linux:': '🐧',
    ':windows:': '🪟',
    ':freebsd:': '😈',
};

function convertEmoji(text) {
    let result = text;
    // First, replace with Buildkite images
    for (const [code, url] of Object.entries(emojiImageMap)) {
        result = result.replaceAll(code, `<img src="${url}" alt="${code}" class="bk-emoji">`);
    }
    // Then replace remaining emoji codes with unicode
    for (const [code, emoji] of Object.entries(emojiMap)) {
        result = result.replaceAll(code, emoji);
    }
    return result;
}

// Plain text version for canvas tooltips
function convertEmojiText(text) {
    let result = text;
    for (const [code, emoji] of Object.entries(emojiTextMap)) {
        result = result.replaceAll(code, emoji);
    }
    for (const [code, emoji] of Object.entries(emojiMap)) {
        result = result.replaceAll(code, emoji);
    }
    return result;
}


// Escape HTML special characters for safe insertion into attributes
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Generate visually distinct colors for jobs using golden ratio distribution.
 * Colors are in HSL format for perceptually uniform distribution.
 * @param {number} count - Number of distinct colors to generate
 * @returns {Array<string>} Array of HSL color strings
 */
function generateColors(count) {
    const colors = [];
    const goldenRatio = 0.618033988749895;
    let hue = 0;
    for (let i = 0; i < count; i++) {
        // Use golden ratio to spread hues evenly
        hue = (hue + goldenRatio) % 1;
        // Vary saturation and lightness slightly for more distinction
        const saturation = 65 + (i % 3) * 10;  // 65%, 75%, 85%
        const lightness = 45 + (i % 5) * 5;    // 45%, 50%, 55%, 60%, 65%
        colors.push(`hsl(${Math.floor(hue * 360)}, ${saturation}%, ${lightness}%)`);
    }
    return colors;
}

function formatDuration(seconds) {
    if (seconds == null) return '<span class="text-muted">—</span>';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const rounded = Math.round(seconds);
    const mins = Math.floor(rounded / 60);
    const secs = rounded % 60;
    if (mins < 60) {
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

/** Compute a centered least-squares trend without claiming statistical significance. */
function computeTrend(runs) {
    if (runs.length < TREND_MIN_POINTS) return null;
    const points = runs.map(run => ({
        x: Date.parse(run.date) / 86400000,
        y: run.duration
    }));
    const n = points.length;
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
    const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    if (denominator === 0) return null;
    const slope = points.reduce(
        (sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0
    ) / denominator;
    const intercept = meanY - slope * meanX;
    const residual = points.reduce(
        (sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0
    );
    const total = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
    const rSquared = total > 0 ? Math.max(0, 1 - residual / total) : 0;
    const minX = Math.min(...points.map(point => point.x));
    const maxX = Math.max(...points.map(point => point.x));
    const startValue = intercept + slope * minX;
    const endValue = intercept + slope * maxX;
    const percentChange = startValue > 0 ? (endValue - startValue) / startValue * 100 : 0;
    return {
        slope, intercept, rSquared, minX, maxX, n, percentChange,
        absoluteDelta: endValue - startValue,
        meaningful: Math.abs(percentChange) >= 1 && rSquared >= 0.1
    };
}

function formatTrend(trend, lineColor = null) {
    if (!trend || trend.n < TREND_MIN_POINTS) {
        return { html: '<span class="text-muted" title="Not enough data points">—</span>', trendData: null };
    }

    const { slope, meaningful, rSquared, percentChange, absoluteDelta } = trend;
    const absSlope = Math.abs(slope);

    // Convert slope to human-readable format (per day)
    let slopeText;
    if (absSlope < 1) {
        slopeText = `${(absSlope * 60).toFixed(1)}s/day`;
    } else if (absSlope < 60) {
        slopeText = `${absSlope.toFixed(1)}s/day`;
    } else {
        slopeText = `${(absSlope / 60).toFixed(1)}m/day`;
    }

    // Format absolute delta
    let deltaText;
    {
        const absDelta = Math.abs(absoluteDelta);
        if (absDelta < 60) {
            deltaText = `${absoluteDelta >= 0 ? '+' : '-'}${absDelta.toFixed(1)}s`;
        } else {
            deltaText = `${absoluteDelta >= 0 ? '+' : '-'}${(absDelta / 60).toFixed(1)}m`;
        }
    }

    // Format percentage change
    const pctSign = percentChange > 0 ? '+' : '';
    const pctText = `${pctSign}${percentChange.toFixed(1)}%`;

    // Direction arrow and color
    let arrow, color;
    if (!meaningful) {
        arrow = '→';
        color = 'var(--color-fg-muted)';
    } else if (slope > 0) {
        arrow = '↗';
        color = 'var(--color-danger-fg)';  // Getting slower is bad
    } else {
        arrow = '↘';
        color = 'var(--color-success-fg)'; // Getting faster is good
    }

    const title = `${slopeText} (${pctText}, ${deltaText} over period)
R²: ${(rSquared * 100).toFixed(1)}%
${meaningful ? 'Meaningful trend' : 'Below the display threshold'}`;
    const displayText = meaningful ? pctText : 'flat';

    // Encode trend data for hover handlers (include line color and axis)
    const trendData = JSON.stringify({
        slope: trend.slope,
        intercept: trend.intercept,
        minX: trend.minX,
        maxX: trend.maxX,
        lineColor: lineColor || 'rgba(128, 128, 128, 0.8)'
    }).replace(/'/g, '&#39;');

    // Return content designed to be placed in a td with class="trend-cell"
    return { html: `<span style="color: ${color}" title="${title}">${arrow} ${displayText}</span>`, trendData };
}

// Regression line dataset management

function showRegressionLine(trendData, lineColor = 'rgba(128, 128, 128, 0.7)') {
    if (!app.chart || !trendData) return;

    const { slope, intercept, minX, maxX } = trendData;

    // Convert days since epoch back to milliseconds
    const msPerDay = 1000 * 60 * 60 * 24;
    const startX = minX * msPerDay;
    const endX = maxX * msPerDay;
    const startY = intercept + slope * minX;
    const endY = intercept + slope * maxX;

    // Create regression line dataset
    app.regressionLine = {
        label: 'Trend line',
        data: [
            { x: new Date(startX), y: startY },
            { x: new Date(endX), y: endY }
        ],
        borderColor: lineColor,
        borderWidth: 2,
        borderDash: [6, 4],
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0,
        order: -1  // Draw on top
    };

    app.chart.data.datasets.push(app.regressionLine);
    app.chart.update('none');
}

function hideRegressionLine() {
    if (!app.chart || !app.regressionLine) return;

    const idx = app.chart.data.datasets.indexOf(app.regressionLine);
    if (idx !== -1) {
        app.chart.data.datasets.splice(idx, 1);
        app.chart.update('none');
    }
    app.regressionLine = null;
}

// Track currently hovered trend cell to properly handle mouseover/mouseout

// Event delegation for trend cell hover using mouseover/mouseout (which bubble)
document.addEventListener('mouseover', (e) => {
    const cell = e.target.closest?.('.trend-cell');
    if (cell && cell !== app.trendCell && cell.dataset.trend) {
        const row = cell.closest('tr[data-job]');
        if (row && !app.selectedJobs.has(row.dataset.job)) return;
        app.trendCell = cell;
        try {
            const trendData = JSON.parse(cell.dataset.trend.replace(/&#39;/g, "'"));
            showRegressionLine(trendData, trendData.lineColor);
        } catch (err) {
            // Ignore parse errors
        }
    } else if (!cell && app.trendCell) {
        app.trendCell = null;
        hideRegressionLine();
    }
});

document.addEventListener('mouseout', (e) => {
    if (!app.trendCell) return;
    // Check if we're leaving to an element outside the current trend cell
    const relatedCell = e.relatedTarget?.closest?.('.trend-cell');
    if (relatedCell !== app.trendCell) {
        app.trendCell = null;
        hideRegressionLine();
    }
});

function filterRunsByDate(runs, cutoff, maxCutoff = null) {
    return runs.filter(run => {
        const date = new Date(run.date);
        return (!cutoff || date >= cutoff) && (!maxCutoff || date <= maxCutoff);
    });
}

// URL parameter handling for shareable links

function stableJobId(name) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < name.length; index++) {
        hash ^= name.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function buildJobCatalog() {
    app.jobNames = Object.keys(app.timingData.jobs).sort();
    app.jobIds.clear();
    app.jobsById.clear();
    for (const name of app.jobNames) {
        const id = stableJobId(name);
        if (app.jobsById.has(id)) throw new Error(`Job identifier collision for ${name}`);
        app.jobIds.set(name, id);
        app.jobsById.set(id, name);
    }
}

/** Compact identifiers keep shared URLs stable when jobs are added or reordered. */
function encodeSelection() {
    const ids = [...app.selectedJobs].map(name => app.jobIds.get(name)).filter(Boolean).sort();
    return `h${ids.join('.')}`;
}

function decodeSelection(param) {
    if (!param) return null;
    if (param.startsWith('h')) {
        const names = param.slice(1).split('.').filter(Boolean).map(id => app.jobsById.get(id));
        return names.every(Boolean) ? { names } : null;
    }
    // Preserve links and local storage written by the previous name-based format.
    if (!param.startsWith('n')) return null;
    try {
        return { names: param.slice(1) ? param.slice(1).split('!').map(decodeURIComponent) : [] };
    } catch {
        return null;
    }
}

function updateURL() {
    const url = new URL(window.location);
    const search = app.jobFilter.trim();
    if (search) {
        url.searchParams.set('q', search);
    } else {
        url.searchParams.delete('q');
    }
    url.searchParams.set('s', encodeSelection());

    if (app.juliaVersion !== 'all') url.searchParams.set('v', app.juliaVersion);
    else url.searchParams.delete('v');

    // Add time range if not default (and not custom zoom)
    if (app.zoom.xMin === null && app.timeRangeDays !== DEFAULT_TIME_RANGE) {
        url.searchParams.set('t', app.timeRangeDays);
    } else if (app.zoom.xMin === null) {
        url.searchParams.delete('t');
    }
    // Add custom zoom ranges if set
    if (app.zoom.xMin !== null) {
        url.searchParams.set('x', `${app.zoom.xMin}.${app.zoom.xMax}`);
        url.searchParams.delete('t');
    } else {
        url.searchParams.delete('x');
    }
    if (app.zoom.yMin !== null) {
        url.searchParams.set('y', `${app.zoom.yMin}.${app.zoom.yMax}`);
    } else {
        url.searchParams.delete('y');
    }
    // Add line type if not default
    if (app.lineType !== DEFAULT_LINE_TYPE) {
        url.searchParams.set('l', app.lineType);
    } else {
        url.searchParams.delete('l');
    }
    // Host expansion and state filters were removed; canonicalize old shared URLs.
    url.searchParams.delete('e');
    url.searchParams.delete('st');

    history.replaceState(null, '', url);
    saveToLocalStorage();
}

function saveToLocalStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, encodeSelection());
    } catch (error) {
        // Persistence is optional.
    }
}

function loadFromLocalStorage() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
        if (!stored) return null;
        // Accept the older JSON shape once, then store only the selection.
        return stored.startsWith("{") ? JSON.parse(stored).selection : stored;
    } catch (error) {
        return null;
    }
}
function applyURLParams() {
    const params = new URLSearchParams(window.location.search);

    // Find the search string
    const q = params.get('q');
    if (q !== null) {
        app.jobFilter = q;
        const input = document.getElementById('job-filter');
        const clearButton = document.getElementById('job-filter-clear');
        if (input) input.value = q;
        if (clearButton) clearButton.style.display = q ? 'block' : 'none';
    }

    const version = params.get('v');
    if (version && document.querySelector(`#julia-version option[value="${CSS.escape(version)}"]`)) {
        app.juliaVersion = version;
        document.getElementById('julia-version').value = version;
    }

    // Apply time range
    const t = params.get('t');
    if (t !== null) {
        const days = parseInt(t, 10);
        if (!isNaN(days) && VALID_TIME_RANGES.includes(days)) {
            app.timeRangeDays = days;
            document.getElementById('time-range').value = days;
        }
    }

    // Apply custom x range (overrides time range)
    const x = params.get('x');
    if (x) {
        const [xMin, xMax] = x.split('.').map(Number);
        if (!isNaN(xMin) && !isNaN(xMax)) {
            app.zoom.xMin = xMin;
            app.zoom.xMax = xMax;
            document.getElementById('time-range').value = 'custom';
            document.getElementById('btn-reset-zoom').style.display = '';
        }
    }

    // Apply custom y range
    const y = params.get('y');
    if (y) {
        const [yMin, yMax] = y.split('.').map(Number);
        if (!isNaN(yMin) && !isNaN(yMax)) {
            app.zoom.yMin = yMin;
            app.zoom.yMax = yMax;
        }
    }

    // Apply line type
    const l = params.get('l');
    if (l !== null && VALID_LINE_TYPES.includes(l)) {
        app.lineType = l;
        document.getElementById('line-type').value = l;
    }


    // Apply selection
    const sel = decodeSelection(params.get('s'));
    if (!sel) return false;

    app.selectedJobs.clear();
    for (const name of sel.names) {
        if (app.timingData.jobs[name]) app.selectedJobs.add(name);
    }
    return true;
}


function setTimeRange(days) {
    app.timeRangeDays = parseInt(days, 10);
    // Clear custom zoom when selecting a preset
    clearCustomZoom();
    updateChart();
    updateStatsTable();
    updateURL();
}

function clearCustomZoom() {
    app.zoom.xMin = null;
    app.zoom.xMax = null;
    app.zoom.yMin = null;
    app.zoom.yMax = null;
    const select = document.getElementById('time-range');
    select.value = app.timeRangeDays;
    document.getElementById('btn-reset-zoom').style.display = 'none';
}

function setCustomZoom(xMin, xMax, yMin, yMax) {
    app.zoom.xMin = xMin;
    app.zoom.xMax = xMax;
    app.zoom.yMin = yMin;
    app.zoom.yMax = yMax;
    // Update dropdown to show "Custom"
    const select = document.getElementById('time-range');
    select.value = 'custom';
    document.getElementById('btn-reset-zoom').style.display = '';
    updateURL();
}

function handleZoomPanComplete({ chart: zoomChart }) {
    const xAxis = zoomChart.scales.x;
    const yAxis = zoomChart.scales.y;
    // Guard against invalid values when chart has no data
    if (!isFinite(xAxis.min) || !isFinite(xAxis.max) || !isFinite(yAxis.min) || !isFinite(yAxis.max)) {
        return;
    }
    setCustomZoom(
        Math.round(xAxis.min),
        Math.round(xAxis.max),
        Math.round(yAxis.min),
        Math.round(yAxis.max)
    );
}

function resetZoom() {
    clearCustomZoom();
    updateChart();
    updateURL();
}

function setLineType(type) {
    app.lineType = type;
    updateChart();
    updateURL();
}
function updateJuliaVersionFilterUI() {
    const select = document.getElementById('julia-version');
    if (!select || !app.timingData?.jobs) return;

    const versions = new Set();

    for (const jobName of Object.keys(app.timingData.jobs)) {
        const lower = jobName.toLowerCase();
        const versionMatch = lower.match(/\b1\.\d+(?:-nightly)?\b|\bnightly\b/);

        if (versionMatch) {
            versions.add(versionMatch[0]);
        }
    }

    const sortedVersions = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
    );

    select.innerHTML = '<option value="all">All Julia versions</option>';

    for (const version of sortedVersions) {
        const option = document.createElement('option');
        option.value = version;
        option.textContent = `Julia ${version}`;
        select.appendChild(option);
    }

    select.value = app.juliaVersion;
}

function getTimeRangeCutoff() {
    // When custom x-range is set, use it for cutoff (with some padding for smoothing)
    if (app.zoom.xMin !== null) {
        // Add 90 days padding before app.zoom.xMin to support smoothing calculations
        return new Date(app.zoom.xMin - 90 * 24 * 60 * 60 * 1000);
    }
    if (app.timeRangeDays === 0) return null;  // All time
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - app.timeRangeDays);
    return cutoff;
}

// Get visible time range bounds for stats (respects custom zoom)
function getVisibleTimeRange() {
    if (app.zoom.xMin !== null) {
        return { min: new Date(app.zoom.xMin), max: new Date(app.zoom.xMax) };
    }
    if (app.timeRangeDays === 0) return { min: null, max: null };  // All time
    const max = new Date();
    const min = new Date();
    min.setDate(min.getDate() - app.timeRangeDays);
    return { min, max };
}

/**
 * Compute a trailing moving average in linear time.
 *
 * @param {Array<Object>} points - Array of {x: Date, y: number} data points
 * @param {number} windowDays - Size of the trailing window in days
 * @returns {Array<Object>} Smoothed points at the original timestamps
 */
function computeMovingAverage(points, windowDays) {
    if (points.length < 2) return points.map(point => ({ x: point.x, y: point.y }));
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const windowMs = windowDays * 86400000;
    const result = [];
    let first = 0;
    let sum = 0;
    for (let last = 0; last < sorted.length; last++) {
        sum += sorted[last].y;
        while (sorted[last].x - sorted[first].x > windowMs) sum -= sorted[first++].y;
        result.push({ x: sorted[last].x, y: sum / (last - first + 1) });
    }
    return result;
}

function buildChartDatasets(jobNames) {
    const datasets = [];
    const cutoff = getTimeRangeCutoff();

    for (const jobName of jobNames) {
        const jobData = app.timingData.jobs[jobName];
        if (!jobData) continue;

        const color = app.colors[jobName];
        const points = [];

        for (const run of jobData.recent) {
            const date = new Date(run.date);
            if (cutoff && date < cutoff) continue;
            points.push({
                x: date,
                y: run.duration,
                meta: {
                    job: jobName,
                    commit: run.commit,
                    date: run.date,
                    duration: run.duration,
                    message: run.message,
                    author: run.author,
                }
            });
        }

        if (points.length === 0) continue;  // Skip jobs with no data in range

        // Sort by date
        points.sort((a, b) => a.x - b.x);

        // Apply moving average if selected
        const smoothedPoints = app.lineType === 'raw' ? points :
            computeMovingAverage(points, parseInt(app.lineType, 10));

        const pointRadius = window.innerWidth <= 480 ? 1.5 : 2;

        if (app.lineType === 'raw') {
            // Single dataset with line and points
            datasets.push({
                label: jobName,
                data: points,
                borderColor: color,
                borderWidth: 1.5,
                backgroundColor: color + '20',
                fill: false,
                tension: 0.2,
                pointRadius: pointRadius,
                pointHoverRadius: pointRadius * 1.2,
                pointHitRadius: 10,
                pointBackgroundColor: color,
                pointBorderColor: color,
                pointBorderWidth: 0,
                pointHoverBorderWidth: 0,
                pointStyle: 'circle',
                spanGaps: true,
                clip: false
            });
        } else {
            // Two datasets: smoothed line + raw points
            // Line dataset (no points)
            datasets.push({
                label: jobName,
                data: smoothedPoints.map(p => ({ x: p.x, y: p.y })),
                borderColor: color,
                borderWidth: 1.5,
                backgroundColor: color + '20',
                fill: false,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: true
            });
            // Points dataset (raw values, no line)
            datasets.push({
                label: jobName + ' (points)',
                data: points,
                borderColor: color,
                backgroundColor: color,
                fill: false,
                showLine: false,
                pointRadius: pointRadius,
                pointHoverRadius: pointRadius * 1.2,
                pointHitRadius: 10,
                pointStyle: 'circle',
                pointBorderColor: color,
                pointBackgroundColor: color,
                pointBorderWidth: 0,
                pointHoverBorderWidth: 0,
                clip: false
            });
        }
    }

    return datasets;
}

function formatTimeTick(value, index, ticks) {
    // Hide labels for minor ticks
    if (ticks[index] && ticks[index].minor) {
        return '';
    }

    const date = new Date(value);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Determine time range to decide format (only count major ticks)
    const majorTicks = ticks.filter(t => !t.minor);
    const rangeMs = majorTicks.length >= 2
        ? majorTicks[majorTicks.length - 1].value - majorTicks[0].value
        : Infinity;
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;

    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    const secs = date.getSeconds().toString().padStart(2, '0');

    // Find previous major tick for date comparison
    let prevMajorTick = null;
    for (let i = index - 1; i >= 0; i--) {
        if (!ticks[i].minor) {
            prevMajorTick = ticks[i];
            break;
        }
    }
    const prevDate = prevMajorTick ? new Date(prevMajorTick.value) : null;
    const isFirstMajor = !prevMajorTick;

    // For ranges under 10 minutes, show seconds
    if (rangeMs < 10 * MINUTE) {
        const timeStr = `${hours}:${mins}:${secs}`;
        if (isFirstMajor) {
            return `${months[date.getMonth()]} ${date.getDate()} ${timeStr}`;
        }
        if (prevDate && prevDate.getDate() !== date.getDate()) {
            return `${months[date.getMonth()]} ${date.getDate()} ${timeStr}`;
        }
        return timeStr;
    }

    // For ranges under 3 days, show time (hours:minutes)
    if (rangeMs < 3 * DAY) {
        const timeStr = `${hours}:${mins}`;
        // Show date on first tick or when date changes
        if (isFirstMajor) {
            return `${months[date.getMonth()]} ${date.getDate()} ${timeStr}`;
        }
        if (prevDate && prevDate.getDate() !== date.getDate()) {
            return `${months[date.getMonth()]} ${date.getDate()} ${timeStr}`;
        }
        return timeStr;
    }

    // Default: day-level labels
    const label = `${months[date.getMonth()]} ${date.getDate()}`;
    // Show year on first tick and when year changes
    if (isFirstMajor) {
        return `${label} '${date.getFullYear().toString().slice(-2)}`;
    }
    if (prevDate && prevDate.getFullYear() !== date.getFullYear()) {
        return `${label} '${date.getFullYear().toString().slice(-2)}`;
    }
    return label;
}

function buildTimeTicks(axis) {
    const rangeMs = axis.max - axis.min;
    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;

    // Nice intervals from seconds to months, with minor tick subdivisions
    const niceStepsWithMinor = [
        { step: 5*SECOND, minor: SECOND },
        { step: 10*SECOND, minor: 2*SECOND },
        { step: 15*SECOND, minor: 5*SECOND },
        { step: 30*SECOND, minor: 10*SECOND },
        { step: MINUTE, minor: 15*SECOND },
        { step: 2*MINUTE, minor: 30*SECOND },
        { step: 5*MINUTE, minor: MINUTE },
        { step: 10*MINUTE, minor: 2*MINUTE },
        { step: 15*MINUTE, minor: 5*MINUTE },
        { step: 30*MINUTE, minor: 10*MINUTE },
        { step: HOUR, minor: 15*MINUTE },
        { step: 2*HOUR, minor: 30*MINUTE },
        { step: 4*HOUR, minor: HOUR },
        { step: 6*HOUR, minor: 2*HOUR },
        { step: 12*HOUR, minor: 3*HOUR },
        { step: DAY, minor: 6*HOUR },
        { step: 2*DAY, minor: DAY },
        { step: 7*DAY, minor: DAY },
        { step: 14*DAY, minor: 7*DAY },
        { step: 30*DAY, minor: 7*DAY }
    ];

    // Find smallest step that gives <= 12 major ticks
    const config = niceStepsWithMinor.find(c => rangeMs / c.step <= 12) || { step: 30*DAY, minor: 7*DAY };
    const step = config.step;
    const minorStep = config.minor;

    // Round min to appropriate boundary
    const minDate = new Date(axis.min);
    let minTick;

    if (step < MINUTE) {
        // Align to second boundary
        minDate.setMilliseconds(0);
        minTick = minDate.getTime();
    } else if (step < HOUR) {
        // Align to minute boundary
        minDate.setSeconds(0, 0);
        minTick = minDate.getTime();
    } else if (step < DAY) {
        // Align to hour boundary
        minDate.setMinutes(0, 0, 0);
        minTick = minDate.getTime();
    } else if (step < 7*DAY) {
        // Align to day boundary
        minDate.setHours(0, 0, 0, 0);
        minTick = minDate.getTime();
    } else {
        // Align to week boundary (Sunday)
        minDate.setHours(0, 0, 0, 0);
        minTick = minDate.getTime();
        const dayOfWeek = minDate.getDay();
        minTick -= dayOfWeek * DAY;
    }

    // Move to first tick after axis.min
    while (minTick < axis.min) minTick += minorStep;

    // Generate ticks with minor flag
    const ticks = [];
    for (let v = minTick; v <= axis.max; v += minorStep) {
        // Check if this is a major tick (aligned to step)
        const isMajor = Math.abs(v % step) < minorStep / 2 || Math.abs((v % step) - step) < minorStep / 2;
        ticks.push({ value: v, major: isMajor, minor: !isMajor });
    }
    if (ticks.length > 0) axis.ticks = ticks;
}

function buildDurationTicks(axis) {
    const range = axis.max - axis.min;
    // Pick step size for nice round numbers
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    let step = niceSteps.find(s => range / s <= 10) || 7200;
    const minTick = Math.ceil(axis.min / step) * step;
    const ticks = [];
    for (let v = minTick; v <= axis.max; v += step) {
        ticks.push({ value: v });
    }
    axis.ticks = ticks;
}

function createChartOptions({ xMin, xMax, isDark, gridColor, textColor }) {
    return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {
                mode: 'nearest',
                intersect: true
            },
            plugins: {
                legend: {
                    display: false
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'xy',
                        modifierKey: null,
                        onPanComplete: handleZoomPanComplete
                    },
                    zoom: {
                        wheel: {
                            enabled: true,
                            modifierKey: null
                        },
                        drag: {
                            enabled: true,
                            backgroundColor: 'rgba(9, 105, 218, 0.2)',
                            borderColor: 'rgba(9, 105, 218, 0.8)',
                            borderWidth: 1
                        },
                        mode: 'xy',
                        onZoomComplete: handleZoomPanComplete
                    }
                },
                tooltip: {
                    borderWidth: 3,
                    borderColor: (ctx) => {
                        if (ctx.tooltip?.dataPoints?.length > 0) {
                            const dp = ctx.tooltip.dataPoints[0];
                            // Get the actual line color
                            const color = dp.dataset.borderColor !== 'transparent'
                                ? dp.dataset.borderColor
                                : dp.dataset.backgroundColor;
                            return color;
                        }
                        return 'transparent';
                    },
                    callbacks: {
                        title: (items) => {
                            if (items.length === 0) return '';
                            const ctx = items[0];
                            // Strip " (points)" suffix from label
                            const label = ctx.dataset.label.replace(' (points)', '');
                            return convertEmojiText(label);
                        },
                        label: (ctx) => {
                            // Only show details for point datasets (pointRadius > 0)
                            if (ctx.dataset.pointRadius === 0) return null;
                            const meta = ctx.raw?.meta;
                            if (!meta) return null;

                            const lines = [formatDuration(ctx.parsed.y)];
                            if (meta.message) lines.push(meta.message);
                            return lines;
                        },
                        labelColor: (ctx) => {
                            // Use actual color (not transparent for points dataset)
                            const color = ctx.dataset.backgroundColor !== 'transparent'
                                ? ctx.dataset.backgroundColor
                                : ctx.dataset.borderColor;
                            return {
                                borderColor: color,
                                backgroundColor: color
                            };
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    min: xMin,
                    max: xMax,
                    time: {
                        displayFormats: {
                            second: 'HH:mm:ss',
                            minute: 'HH:mm',
                            hour: 'MMM d HH:mm',
                            day: 'MMM d',
                            week: 'MMM d',
                            month: 'MMM yyyy'
                        }
                    },
                    ticks: {
                        color: textColor,
                        maxRotation: 45,
                        callback: formatTimeTick
                    },
                    grid: {
                        color: (ctx) => {
                            // Minor grid lines are lighter
                            if (ctx.tick && ctx.tick.minor) {
                                return isDark ? 'rgba(48, 54, 61, 0.5)' : 'rgba(208, 215, 222, 0.5)';
                            }
                            return gridColor;
                        }
                    },
                    afterBuildTicks: buildTimeTicks
                },
                y: {
                    min: app.zoom.yMin ?? 0,
                    max: app.zoom.yMax || undefined,
                    title: {
                        display: true,
                        text: 'Duration',
                        color: textColor
                    },
                    ticks: {
                        color: textColor,
                        callback: (v) => formatDuration(v),
                        // Use nice intervals: 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h
                        autoSkip: true,
                        maxTicksLimit: 10
                    },
                    grid: { color: gridColor },
                    afterBuildTicks: buildDurationTicks
                },
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const el = elements[0];
                    const meta = app.chart.data.datasets[el.datasetIndex].data[el.index]?.meta;
                    if (meta) showPopup(meta);
                }
            },
            onHover: (evt, elements) => {
                if (elements.length > 0) {
                    const el = elements[0];
                    const meta = app.chart.data.datasets[el.datasetIndex].data[el.index]?.meta;
                    if (meta && meta.job) {
                        highlightStatsRow(meta.job);
                    }
                } else {
                    clearStatsRowHighlight();
                }
            }

    };
}

function updateChart() {
    const selectedArray = getPlottedJobNames();
    if (selectedArray.length === 0) {
        hideRegressionLine();
        app.trendCell = null;
        if (app.chart) app.chart.destroy();
        app.chart = null;
        return;
    }

    const datasets = buildChartDatasets(selectedArray);

    hideRegressionLine();
    app.trendCell = null;
    app.highlightActive = false;

    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const gridColor = isDark ? '#30363d' : '#d0d7de';
    const textColor = isDark ? '#8b949e' : '#656d76';

    // Calculate x-axis bounds based on time range or custom zoom
    let xMin, xMax;
    if (app.zoom.xMin !== null) {
        xMin = app.zoom.xMin;
        xMax = app.zoom.xMax;
    } else if (app.timeRangeDays > 0) {
        xMax = Date.now();
        xMin = xMax - app.timeRangeDays * 24 * 60 * 60 * 1000;
    }
    // For "All time" (app.timeRangeDays === 0), leave undefined to auto-scale
    if (app.chart) {
        app.chart.data.datasets = datasets;
        app.chart.options.scales.x.min = xMin;
        app.chart.options.scales.x.max = xMax;
        app.chart.options.scales.y.min = app.zoom.yMin ?? undefined;
        app.chart.options.scales.y.max = app.zoom.yMax ?? undefined;
        app.chart.update('none');
        return;
    }

    const ctx = document.getElementById('timing-chart').getContext('2d');
    app.chart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: createChartOptions({ xMin, xMax, isDark, gridColor, textColor })
    });
}

function showPopup(meta) {
    document.getElementById("popup-job").innerHTML = convertEmoji(escapeHtml(meta.job));

    document.getElementById("popup-duration").textContent = formatDuration(meta.duration);
    document.getElementById("popup-date").textContent = meta.date;
    document.getElementById("popup-commit").textContent = meta.commit;
    document.getElementById("popup-message").textContent = meta.message || "(no message)";
    document.getElementById("popup-author").textContent = meta.author || "(unknown)";
    document.getElementById("popup-github-link").href =
        "https://github.com/oscar-system/Oscar.jl/commit/" + meta.commit;
    document.getElementById("popup-overlay").classList.add("visible");
}

function closePopup() {
    document.getElementById('popup-overlay').classList.remove('visible');
}

// Helper to convert HSL to RGB
function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Helper to convert any color to rgba with specified alpha
function colorToRgba(color, alpha) {
    if (!color || typeof color !== 'string') return color;

    // Handle hex colors
    const hexResult = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(color);
    if (hexResult) {
        return `rgba(${parseInt(hexResult[1], 16)}, ${parseInt(hexResult[2], 16)}, ${parseInt(hexResult[3], 16)}, ${alpha})`;
    }

    // Handle hsl colors - convert to rgba
    const hslMatch = color.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (hslMatch) {
        const [r, g, b] = hslToRgb(parseInt(hslMatch[1]), parseInt(hslMatch[2]), parseInt(hslMatch[3]));
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // Handle rgb colors
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
        return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
    }

    // Handle rgba - replace the alpha
    const rgbaMatch = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
    if (rgbaMatch) {
        return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`;
    }

    // Handle hsla - convert to rgba
    const hslaMatch = color.match(/hsla\((\d+),\s*(\d+)%,\s*(\d+)%,\s*[\d.]+\)/);
    if (hslaMatch) {
        const [r, g, b] = hslToRgb(parseInt(hslaMatch[1]), parseInt(hslaMatch[2]), parseInt(hslaMatch[3]));
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    return color;
}

// Stats row highlighting (for chart hover)
function highlightStatsRow(jobName) {
    clearStatsRowHighlight();
    // Find row by iterating (safer than CSS selector with special chars)
    const rows = document.querySelectorAll('#stats-tbody tr[data-job]');
    for (const row of rows) {
        if (row.dataset.job === jobName) {
            row.classList.add('chart-hover-highlight');
            app.highlightedRow = row;
            // Scroll into view if not visible
            const wrapper = document.getElementById('stats-wrapper');
            if (wrapper) {
                const rowRect = row.getBoundingClientRect();
                const wrapperRect = wrapper.getBoundingClientRect();
                if (rowRect.top < wrapperRect.top || rowRect.bottom > wrapperRect.bottom) {
                    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }
            break;
        }
    }
}

function clearStatsRowHighlight() {
    if (app.highlightedRow) {
        app.highlightedRow.classList.remove('chart-hover-highlight');
        app.highlightedRow = null;
    }
}

// Highlight a specific chart dataset, de-emphasizing others

function highlightChartDataset(jobColor) {
    if (!app.chart) return;

    if (!app.highlightActive) {
        app.chart.data.datasets.forEach(dataset => {
            dataset._originalBorderColor = dataset.borderColor;
            dataset._originalBackgroundColor = dataset.backgroundColor;
            dataset._originalBorderWidth = dataset.borderWidth;
            dataset._originalPointRadius = dataset.pointRadius;
        });
        app.highlightActive = true;
    }

    app.chart.data.datasets.forEach(dataset => {
        const matches = dataset._originalBorderColor === jobColor;
        dataset.borderColor = matches ? dataset._originalBorderColor : colorToRgba(dataset._originalBorderColor, 0.25);
        dataset.backgroundColor = matches ? dataset._originalBackgroundColor : colorToRgba(dataset._originalBackgroundColor, 0.25);
        dataset.borderWidth = matches ? dataset._originalBorderWidth : 1;
        if (!matches && dataset._originalPointRadius !== undefined) {
            dataset.pointRadius = Array.isArray(dataset._originalPointRadius)
                ? dataset._originalPointRadius.map(radius => radius / 2)
                : dataset._originalPointRadius / 2;
        }
    });
    app.chart.update();
}

function clearChartHighlight() {
    if (!app.chart || !app.highlightActive) return;
    app.chart.data.datasets.forEach(dataset => {
        dataset.borderColor = dataset._originalBorderColor;
        dataset.backgroundColor = dataset._originalBackgroundColor;
        dataset.borderWidth = dataset._originalBorderWidth;
        dataset.pointRadius = dataset._originalPointRadius;
    });
    app.highlightActive = false;
    app.chart.update();
}

// Resizable stats panel
(function() {
    const handle = document.getElementById('resize-handle');
    const wrapper = document.getElementById('stats-wrapper');
    let startY, startHeight;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startHeight = wrapper.offsetHeight;
        wrapper.style.flex = '0 0 auto';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    });

    function onMouseMove(e) {
        const delta = startY - e.clientY;
        const newHeight = Math.max(50, Math.min(window.innerHeight * 0.7, startHeight + delta));
        wrapper.style.height = newHeight + 'px';
    }

    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }

})();

// Close popup on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.getElementById('popup-overlay').classList.remove('visible');
        document.getElementById('shortcuts-overlay').classList.remove('visible');
    }
    // Keyboard shortcuts (when not typing in an input)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        toggleShortcutsHelp();
    } else if (e.key === 'r') {
        e.preventDefault();
        if (app.zoom.xMin !== null || app.zoom.yMin !== null) resetZoom();
    }
});

function toggleShortcutsHelp() {
    document.getElementById('shortcuts-overlay').classList.toggle('visible');
}

function updateStatsTable() {
    const tbody = document.getElementById('stats-tbody');
    tbody.innerHTML = '';


    const visibleJobNames = getVisibleJobNames();
    if (visibleJobNames.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading">No matching jobs</td></tr>`;
        updateSortIndicators();
        syncStatsSelectAllCheckbox();
        return;
    }

    const { min: rangeMin, max: rangeMax } = getVisibleTimeRange();
    const rangeKey = app.zoom.xMin === null
        ? `preset:${app.timeRangeDays}`
        : `custom:${app.zoom.xMin}:${app.zoom.xMax}`;
    if (rangeKey !== app.stats.rangeKey) {
        app.stats.rangeKey = rangeKey;
        app.stats.cache.clear();
    }

    // First, compute stats for each job shown by the search filter.
    // Selection controls plotting; it no longer controls whether the row exists.
    const jobStats = [];
    for (const jobName of visibleJobNames) {
        const job = app.timingData.jobs[jobName];
        if (!job) continue;

        const cached = app.stats.cache.get(jobName);
        if (cached) {
            jobStats.push(cached);
            continue;
        }
        const filtered = filterRunsByDate(job.recent, rangeMin, rangeMax);
        if (filtered.length === 0) continue;

        // Duration statistics for runs in the visible date range
        let median = null, min = null, max = null, std = null, trend = null;
        if (filtered.length > 0) {
            const durations = filtered.map(r => r.duration);
            const sorted = [...durations].sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
            const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
            min = Math.min(...durations);
            max = Math.max(...durations);
            const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
            std = Math.sqrt(variance);
            trend = computeTrend(filtered);
        }

        const stats = {
            jobName,
            color: app.colors[jobName],
            median,
            min,
            max,
            std,
            trend,
            n: filtered.length
        };
        app.stats.cache.set(jobName, stats);
        jobStats.push(stats);
    }

    // Sort based on current sort column
    jobStats.sort((a, b) => {
        let cmp = 0;
        switch (app.stats.column) {
            case 'job':
                cmp = a.jobName.localeCompare(b.jobName);
                break;
            case 'median':
                cmp = a.median - b.median;
                break;
            case 'min':
                cmp = a.min - b.min;
                break;
            case 'max':
                cmp = a.max - b.max;
                break;
            case 'std':
                cmp = a.std - b.std;
                break;
            case 'trend':
                // Sort by: meaningful positive (worst) → flat → meaningful negative (best)
                // Tier: 1 = meaningful positive, 0 = flat/small, -1 = meaningful negative
                const getTrendTier = (t) => {
                    if (!t || !t.meaningful) return 0;  // flat
                    return t.percentChange > 0 ? 1 : -1;
                };
                const tierA = getTrendTier(a.trend);
                const tierB = getTrendTier(b.trend);
                if (tierA !== tierB) {
                    cmp = tierA - tierB;
                } else {
                    // Within same tier, sort by magnitude
                    const pctA = a.trend?.percentChange ?? 0;
                    const pctB = b.trend?.percentChange ?? 0;
                    cmp = pctA - pctB;
                }
                break;
            case 'n':
                cmp = a.n - b.n;
                break;
        }
        return app.stats.ascending ? cmp : -cmp;
    });

    // Render rows


    for (const stat of jobStats) {
        const { jobName, color, median, min, max, std, trend, n } = stat;

        const row = document.createElement('tr');
        row.dataset.job = jobName;
        row.onmouseenter = () => {
            if (getPlottedJobNames().includes(jobName)) highlightChartDataset(color);
        };
        row.onmouseleave = () => clearChartHighlight();
        const trendResult = formatTrend(trend, color);
        const trendCell = trendResult.trendData
            ? `<td class="trend-cell" data-trend='${trendResult.trendData}'>${trendResult.html}</td>`
            : `<td>${trendResult.html}</td>`;

        row.innerHTML = `
            <td class="stats-select-col"><input type="checkbox" class="stats-job-checkbox" data-job="${escapeHtml(jobName)}" ${app.selectedJobs.has(jobName) ? 'checked' : ''} aria-label="Show ${escapeHtml(convertEmojiText(jobName))}"></td>
            <td><span class="color-dot" style="background: ${color}"></span> ${convertEmoji(escapeHtml(jobName))}</td>
            ${trendCell}
            <td class="duration">${formatDuration(median)}</td>
            <td class="duration">${formatDuration(min)}</td>
            <td class="duration">${formatDuration(max)}</td>
            <td class="duration">${std != null ? '±' + formatDuration(std) : formatDuration(null)}</td>
            <td>${n}</td>
        `;
        row.querySelector('.stats-job-checkbox')?.addEventListener('change', (event) => {
            toggleStatsJob(jobName, event.target.checked);
        });
        tbody.appendChild(row);
    }

    updateSortIndicators();
    syncStatsSelectAllCheckbox();
}

function updateSortIndicators() {
    const headers = document.querySelectorAll('.stats-bar th.sortable');
    headers.forEach(th => {
        const col = th.dataset.sort;
        const indicator = th.querySelector('.sort-indicator');
        if (col === app.stats.column) {
            th.classList.add('sorted');
            indicator.textContent = app.stats.ascending ? '▲' : '▼';
        } else {
            th.classList.remove('sorted');
            indicator.textContent = '▲';
        }
    });
}

function handleStatsTableSort(column) {
    if (app.stats.column === column) {
        app.stats.ascending = !app.stats.ascending;
    } else {
        app.stats.column = column;
        app.stats.ascending = column === 'job';  // Job defaults to ascending, others to descending
    }
    updateStatsTable();
}

function getVisibleJobNames() {
    if (!app.timingData?.jobs) return [];

    const filter = app.jobFilter.trim().toLowerCase();

    return app.jobNames.filter(name => {
        const info = app.jobInfo.get(name);
        return (filter === '' || info.searchText.includes(filter)) &&
            (app.juliaVersion === 'all' || info.version === app.juliaVersion);
    });
}

function getPlottedJobNames() {
    return getVisibleJobNames().filter(name => app.selectedJobs.has(name));
}

function setJobFilter(value) {
    app.jobFilter = value;
    const clearButton = document.getElementById('job-filter-clear');
    clearButton.style.display = value ? 'block' : 'none';

    if (app.filterTimer !== null) {
        clearTimeout(app.filterTimer);
    }

    app.filterTimer = setTimeout(() => {
        updateChart();
        updateStatsTable();
        updateURL();
        app.filterTimer = null;
    }, 150);
}

function clearJobFilter() {
    const input = document.getElementById('job-filter');
    input.value = '';
    setJobFilter('');
    input.focus();
}

function populateJobSelector() {
    buildJobCatalog();

    // Assign colors
    const allJobs = Object.keys(app.timingData.jobs);
    const colors = generateColors(allJobs.length);
    app.jobInfo = new Map();
    allJobs.forEach((name, i) => {
        app.colors[name] = colors[i];
        const searchText = convertEmojiText(name).toLowerCase();
        const match = searchText.match(/\b1\.\d+(?:-nightly)?\b|\bnightly\b/);
        app.jobInfo.set(name, { searchText, version: match?.[0] ?? null });
    });
}

function timeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
}

function initializeDashboard() {
    document.getElementById('time-range').addEventListener('change', event => setTimeRange(event.target.value));
    document.getElementById('line-type').addEventListener('change', event => setLineType(event.target.value));
    document.getElementById('julia-version').addEventListener('change', event => setJuliaVersion(event.target.value));
    document.getElementById('job-filter').addEventListener('input', event => setJobFilter(event.target.value));
    document.getElementById('job-filter-clear').addEventListener('click', clearJobFilter);
    document.getElementById('btn-reset-zoom').addEventListener('click', resetZoom);
    document.getElementById('shortcuts-help-button').addEventListener('click', toggleShortcutsHelp);
    document.getElementById('stale-warning-close').addEventListener('click', () =>
        document.getElementById('stale-data-warning').classList.remove('visible'));
    document.getElementById('popup-close').addEventListener('click', closePopup);
    document.getElementById('popup-overlay').addEventListener('click', event => {
        if (event.target.id === 'popup-overlay') closePopup();
    });
    document.getElementById('shortcuts-overlay').addEventListener('click', event => {
        if (event.target.id === 'shortcuts-overlay') toggleShortcutsHelp();
    });
    document.getElementById('stats-select-all').addEventListener('change', event =>
        toggleAllVisibleStatsJobs(event.target.checked));
    document.getElementById('stats-thead').addEventListener('click', event => {
        const header = event.target.closest('th.sortable');
        if (header) handleStatsTableSort(header.dataset.sort);
    });
}

async function loadData() {
    try {
        const response = await fetch("data/timing_summary.json");
        if (!response.ok) throw new Error("HTTP " + response.status);
        const payload = await response.json();
        if (!payload.jobs || typeof payload.jobs !== 'object' || Array.isArray(payload.jobs)) {
            throw new Error('Unsupported timing data schema');
        }

        // The producer currently emits timezone-less ISO timestamps. Its
        // benchmark clock is UTC, so make that assumption explicit in memory.
        const normalizeTimestamp = value => {
            if (typeof value !== 'string') throw new Error('Invalid timestamp');
            const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
            if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp');
            return timestamp;
        };

        payload.generated_at = normalizeTimestamp(payload.generated_at);
        for (const [name, job] of Object.entries(payload.jobs)) {
            if (!job || !Array.isArray(job.recent)) {
                throw new Error(`Invalid timing series for ${name}`);
            }
            for (const run of job.recent) {
                if (!Number.isFinite(run.duration) || run.duration < 0) {
                    throw new Error(`Invalid duration for ${name}`);
                }
                run.date = normalizeTimestamp(run.date);
            }
        }
        app.timingData = payload;

        const updatedEl = document.getElementById("last-updated");
        updatedEl.textContent = "Updated " + timeAgo(app.timingData.generated_at);
        updatedEl.title = app.timingData.generated_at;
        checkStaleData(app.timingData.generated_at);

        populateJobSelector();
        app.selectedJobs.clear();
        const hasURLSelection = applyURLParams();

        if (!hasURLSelection) {
            const storedSelection = decodeSelection(loadFromLocalStorage());
            for (const name of storedSelection?.names ?? []) {
                if (app.timingData.jobs[name]) app.selectedJobs.add(name);
            }
        }

        document.getElementById("chart-loading").style.display = "none";
        refreshAllUI();
    } catch (error) {
        console.error("Failed to load timing data:", error);
        const invalidData = error instanceof SyntaxError || error.message.includes("schema") || error.message.includes("series") || error.message.includes("timestamp") || error.message.includes("duration");
        const errorText = invalidData ? "Timing data is invalid" : "Failed to load timing data";
        const retryButton = '<button class="btn btn-retry" type="button">Retry</button>';
        document.getElementById("chart-loading").innerHTML =
            `<span class="error">${errorText}</span>` + retryButton;
        document.getElementById("stats-tbody").innerHTML =
            `<tr><td colspan="8" class="error">${errorText}. ${retryButton}</td></tr>`;
        document.querySelectorAll('.btn-retry').forEach(button =>
            button.addEventListener('click', () => location.reload()));
    }
}

function checkStaleData(generatedAt) {
    const age = Date.now() - new Date(generatedAt).getTime();
    document.getElementById("stale-data-warning").classList
        .toggle("visible", age > STALE_DATA_THRESHOLD_MS);
}

initializeDashboard();
loadData();

// Update "ago" time periodically
setInterval(() => {
    if (app.timingData?.generated_at) {
        const updatedEl = document.getElementById('last-updated');
        updatedEl.textContent = `Updated ${timeAgo(app.timingData.generated_at)}`;
    }
}, AGO_UPDATE_INTERVAL);

// Re-render chart when color scheme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.chart) { app.chart.destroy(); app.chart = null; }
    if (app.selectedJobs.size > 0) updateChart();
});
