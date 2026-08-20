// Unit test for the mode availability strip in templates/monitor.html.
//
// Runs the SHIPPED page JavaScript, not a reimplementation, against a graph
// fixture captured from a live Autoware 1.5.0 diagnostic graph. Needs no ROS,
// no rosbridge, no vehicle: `node test/mode_strip_render_test.js`.
//
// What it is really protecting: struct and status are joined BY ARRAY INDEX.
// DiagNodeStatus carries no path field, so an off-by-one silently mislabels
// every chip and the page still looks entirely plausible. The fixture keeps the
// real node ordering for that reason, and nothing in it may be renumbered.
//
// Phase 4-O sub-phase O-C. The live end-to-end counterpart is
// scripts/check/mode_strip_test.sh in the golf cart repo, which injects a real
// fault and times the reaction.

const fs = require('fs');
const path = require('path');

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'graph_fixture.json'), 'utf8'));
const STRUCT = fixture.struct;
const STATUS = fixture.status;

// ---- minimal DOM and WebSocket, enough for the strip ----------------------
const els = {};
const mkEl = (id) => (els[id] = { id, className: '', textContent: '', innerHTML: '' });
['mode-chips', 'bridge-state', 'mode-note'].forEach(mkEl);
global.document = { getElementById: (id) => els[id] || mkEl(id) };
global.location = { hostname: '127.0.0.1' };
global.setTimeout = () => 0;
global.setInterval = () => 0;
global.clearTimeout = () => {};

let sock = null;
global.WebSocket = function () {
    this.readyState = 1;
    this.sent = [];
    this.send = (s) => this.sent.push(JSON.parse(s));
    this.close = () => {};
    sock = this;
    setImmediate(() => this.onopen && this.onopen());
};
global.WebSocket.OPEN = 1;

// ---- load the strip out of the template ----------------------------------
const tpl = fs.readFileSync(
    path.join(__dirname, '..', 'golfcart_system_monitor', 'templates', 'monitor.html'), 'utf8');
const START = '(function () {';
const END = '// =================== end mode availability strip';
const from = tpl.indexOf(START);
const to = tpl.indexOf(END);
if (from < 0 || to < 0 || to < from) {
    console.error('FAIL: could not find the mode-strip block in monitor.html.');
    console.error('If it was renamed, update the START/END markers here.');
    process.exit(1);
}
// The template is Jinja; substitute the one placeholder the strip uses.
eval(tpl.slice(from, to).replace('{{ rosbridge_port }}', '9090'));

// ---- helpers --------------------------------------------------------------
const deliver = (topic, msg) =>
    sock.onmessage({ data: JSON.stringify({ op: 'publish', topic, msg }) });

const chips = () =>
    (els['mode-chips'].innerHTML.match(/class="mode-chip ([a-z- ]+)"[^>]*>([^<]+)</g) || [])
        .map((s) => {
            const m = /class="mode-chip ([a-z- ]+)"[^>]*>([^<]+)</.exec(s);
            return m[2] + '=' + m[1].trim();
        });

function statusWith(levels, latch) {
    const s = JSON.parse(JSON.stringify(STATUS));
    s.nodes.forEach((n) => { n.level = 0; n.latch_level = 0; });
    STRUCT.nodes.forEach((n, i) => {
        const name = n.path.replace('/autoware/modes/', '');
        if (levels && levels[name] !== undefined) s.nodes[i].level = levels[name];
        if (latch && latch[name] !== undefined) s.nodes[i].latch_level = latch[name];
    });
    return s;
}

let fails = 0;
function check(label, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '\n           ' + detail : ''));
    if (!cond) fails++;
}

// ---- checks ---------------------------------------------------------------
setImmediate(() => {
    check('subscribes to struct and status', sock.sent.length === 2,
        sock.sent.map((s) => s.topic).join(', '));

    // O-A found these two topics disagree on QoS. rosbridge derives it per topic
    // from the publishers; pinning it here would reintroduce the bug it avoids.
    check('no QoS is pinned on either subscription',
        !sock.sent.some((s) => 'qos' in s || 'durability' in s || 'reliability' in s));

    check('status is throttled server side',
        sock.sent.some((s) => s.topic.endsWith('/status') && s.throttle_rate > 0),
        'throttle_rate=' + (sock.sent.find((s) => s.topic.endsWith('/status')) || {}).throttle_rate);

    deliver('/api/system/diagnostics/struct', STRUCT);
    const c1 = chips();
    check('one chip per mode root, read from the graph', c1.length === 7, c1.length + ' chips');
    check('struct but no status renders unknown, never as a fault',
        c1.every((c) => c.endsWith('=mode-unknown')), c1.join(' '));

    deliver('/api/system/diagnostics/status', statusWith({}));
    check('all-OK renders all green', chips().every((c) => c.endsWith('=mode-ok')), chips().join(' '));

    // The real case: one AEB leaf fault takes out three modes and leaves four.
    deliver('/api/system/diagnostics/status',
        statusWith({ autonomous: 2, pull_over: 2, comfortable_stop: 2 }));
    const c3 = chips();
    check('faulted modes go red',
        ['autonomous', 'pull_over', 'comfortable_stop'].every((m) => c3.includes(m + '=mode-error')),
        c3.join(' '));
    check('unaffected modes stay green',
        ['local', 'remote', 'stop', 'emergency_stop'].every((m) => c3.includes(m + '=mode-ok')));

    deliver('/api/system/diagnostics/status', statusWith({}, { autonomous: 2 }));
    check('a fault that has already cleared is still marked',
        chips().includes('autonomous=mode-ok latched'), chips().join(' '));

    // An aggregator restart rebuilds the graph and changes its id. Indexing the
    // new status into the old struct would mislabel every chip.
    const other = statusWith({});
    other.id = 'DIFFERENT';
    deliver('/api/system/diagnostics/status', other);
    check('a changed graph id reloads instead of mislabelling',
        /reloading/.test(els['mode-chips'].innerHTML));

    // A page that cannot reach the bridge must not read as "no faults".
    sock.onclose();
    check('a dropped bridge blanks the chips and says so',
        /no data/.test(els['mode-chips'].innerHTML)
        && /bridge-down/.test(els['bridge-state'].className)
        && /not the same as/.test(els['mode-note'].textContent),
        els['bridge-state'].textContent);

    console.log(fails === 0
        ? '\nALL CHECKS PASSED'
        : '\n' + fails + ' CHECK(S) FAILED');
    process.exit(fails === 0 ? 0 : 1);
});
