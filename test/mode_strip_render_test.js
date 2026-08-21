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
// Phase 4-O sub-phases O-C (the chips), O-D (the failing path) and O-E (the
// fail-safe timeline). The live end-to-end counterpart is
// scripts/check/mode_strip_test.sh in the golf cart repo, which injects a real
// fault and times the reaction.
//
// The O-D checks fault a named LEAF and propagate the level up through the
// fixture's real `links`, rather than setting mode levels directly. That keeps
// the traversal under test: attribution must name the leaf, never an ancestor
// unit that merely inherited the level.

const fs = require('fs');
const path = require('path');

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'graph_fixture.json'), 'utf8'));
const STRUCT = fixture.struct;
const STATUS = fixture.status;

// ---- minimal DOM and WebSocket, enough for the strip ----------------------
const els = {};
const mkEl = (id) => (els[id] = { id, className: '', textContent: '', innerHTML: '', onclick: null });
['mode-chips', 'bridge-state', 'mode-note', 'fault-paths', 'fault-toggle',
 'timeline-rows'].forEach(mkEl);
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
    s.diags.forEach((d) => { d.level = 0; });
    STRUCT.nodes.forEach((n, i) => {
        const name = n.path.replace('/autoware/modes/', '');
        if (levels && levels[name] !== undefined) s.nodes[i].level = levels[name];
        if (latch && latch[name] !== undefined) s.nodes[i].latch_level = latch[name];
    });
    return s;
}

// Fault one named LEAF and propagate the level up every ancestor unit, the way
// the aggregator does. Used for the O-D failing-path checks, so the fixture
// stays a plain capture rather than a hand-built tree.
function statusWithLeafFaults(names, level) {
    const s = statusWith({});
    const parentOf = {};
    STRUCT.links.forEach((l) => { (parentOf[l.child] = parentOf[l.child] || []).push(l.parent); });
    names.forEach((name) => {
        const j = STRUCT.diags.findIndex((d) => d.name === name);
        if (j < 0) throw new Error('fixture has no leaf named ' + name);
        s.diags[j].level = level;
        const up = [STRUCT.diags[j].parent];
        const seen = {};
        while (up.length) {
            const i = up.pop();
            if (seen[i]) continue;
            seen[i] = true;
            s.nodes[i].level = Math.max(s.nodes[i].level, level);
            (parentOf[i] || []).forEach((p) => up.push(p));
        }
    });
    return s;
}

const paths = () => els['fault-paths'].innerHTML;

let fails = 0;
function check(label, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '\n           ' + detail : ''));
    if (!cond) fails++;
}

// ---- checks ---------------------------------------------------------------
setImmediate(() => {
    // Two for the graph (O-C/O-D) and three for the timeline (O-E).
    check('subscribes to the graph and the fail-safe topics', sock.sent.length === 5,
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
    // Before anything has ever faulted, the fault list must be silent. Later in
    // this file it is deliberately NOT empty after a fault clears: retention
    // across the session is the point of O-D, so this has to be asserted here.
    check('a never-faulted system shows no fault paths at all', paths() === '',
        JSON.stringify(paths().slice(0, 60)));

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

    // ---- O-D: the failing path ------------------------------------------
    const AEB = 'autonomous_emergency_braking: aeb_emergency_stop';
    const NDT = 'ndt_scan_matcher: scan_matching_status';

    deliver('/api/system/diagnostics/status', statusWithLeafFaults([AEB], 2));
    check('the originating leaf is named', paths().includes(AEB));
    check('unavailable modes are listed', /autonomous[\s\S]*unavailable/.test(paths()));
    // Attribution must name the LEAF, not an ancestor unit that merely
    // inherited the level. is_dependent reads false on every node in this
    // graph, so the traversal must not rely on it.
    check('no inherited unit is reported as a cause',
        !/class="fault-leaf">\/autoware\//.test(paths()),
        (paths().match(/class="fault-leaf">[^<]*/g) || []).join(' | '));

    // Two faults under different subtrees. Both must be named, and the mode
    // that depends on both must list both.
    deliver('/api/system/diagnostics/status', statusWithLeafFaults([AEB, NDT], 2));
    check('two simultaneous faults both name their originating leaf',
        paths().includes(AEB) && paths().includes(NDT),
        (paths().match(/class="fault-leaf">[^<]*/g) || []).join(' | '));

    // The unit chain is the expandable detail, not the default view: rendering
    // all 63 nodes would bury the one red line through them.
    check('the unit chain is present but collapsed by default',
        paths().includes('fault-chain') && !/class="fault-mode[^"]*expanded/.test(paths()));
    els['fault-toggle'].onclick();
    check('expanding reveals the chain of graph units',
        /class="fault-mode[^"]*expanded/.test(paths())
        && /\/autoware\/control[\s\S]*&gt;/.test(paths()));
    els['fault-toggle'].onclick();

    // latch_level is inert on this vehicle: upstream's graph configures no
    // latching, so the field stays 0 even while a node is at ERROR. Retention
    // therefore has to be client side, or a fault that clears before anyone
    // looks leaves no trace.
    deliver('/api/system/diagnostics/status', statusWith({}));
    check('a cleared fault is still attributable after it recovers',
        paths().includes(AEB) && /recovered/.test(paths()),
        JSON.stringify(paths().slice(0, 120)));

    // An aggregator restart rebuilds the graph and changes its id. Indexing the
    // new status into the old struct would mislabel every chip.
    const other = statusWith({});
    other.id = 'DIFFERENT';
    deliver('/api/system/diagnostics/status', other);
    check('a changed graph id reloads instead of mislabelling',
        /reloading/.test(els['mode-chips'].innerHTML));

    // ---- O-E: the fail-safe timeline -------------------------------------
    const tl = () => els['timeline-rows'].innerHTML;
    const rows = () => (tl().match(/class="tl-val [^"]*">[^<]*/g) || [])
        .map((r) => r.replace(/^[^>]*>/, ''));

    // The stub DOM starts blank rather than carrying the template's
    // "nothing recorded yet" placeholder, so assert on the row count.
    check('the timeline starts empty', rows().length === 0, JSON.stringify(tl()));

    deliver('/api/fail_safe/mrm_state', { state: 2, behavior: 3 });
    check('mrm state and behavior are labelled, not left as integers',
        rows().some((r) => r.includes('MRM_OPERATING') && r.includes('COMFORTABLE_STOP')),
        rows().join(' | '));

    deliver('/system/emergency/hazard_status',
        { status: { level: 3, emergency: true, emergency_holding: false } });
    check('hazard level is labelled and emergency is called out',
        rows().some((r) => r.includes('SINGLE_POINT_FAULT') && r.includes('emergency')));

    deliver('/system/operation_mode/availability',
        { stop: true, autonomous: false, local: true, remote: false,
          emergency_stop: true, comfortable_stop: false, pull_over: false });
    check('availability lists what IS available',
        rows().some((r) => r.includes('stop') && r.includes('local')
                           && !r.includes('autonomous')), rows()[0]);

    const before = rows().length;
    // These topics republish at rate. A timeline that logs every message is a
    // log, not a timeline.
    deliver('/api/fail_safe/mrm_state', { state: 2, behavior: 3 });
    deliver('/system/emergency/hazard_status',
        { status: { level: 3, emergency: true, emergency_holding: false } });
    check('repeats of an unchanged value are not recorded',
        rows().length === before, before + ' -> ' + rows().length);

    deliver('/api/fail_safe/mrm_state', { state: 3, behavior: 2 });
    check('a change IS recorded', rows().length === before + 1);
    check('newest is first', rows()[0].includes('MRM_SUCCEEDED'), rows()[0]);

    deliver('/system/operation_mode/availability',
        { stop: false, autonomous: false, local: false, remote: false,
          emergency_stop: false, comfortable_stop: false, pull_over: false });
    check('nothing available is stated in words, not shown as a blank row',
        rows()[0].includes('NOTHING AVAILABLE'), rows()[0]);

    // A page that cannot reach the bridge must not read as "no faults".
    const beforeDrop = rows().length;
    sock.onclose();
    check('a dropped bridge blanks the chips and says so',
        /no data/.test(els['mode-chips'].innerHTML)
        && /bridge-down/.test(els['bridge-state'].className)
        && /not the same as/.test(els['mode-note'].textContent),
        els['bridge-state'].textContent);
    // The timeline is the record of what happened, and a bridge drop is when
    // that record matters most. Clearing it would destroy the evidence.
    check('a dropped bridge does NOT clear the timeline, and is itself logged',
        rows().length === beforeDrop + 1 && /DISCONNECTED/.test(rows()[0]),
        rows()[0]);

    console.log(fails === 0
        ? '\nALL CHECKS PASSED'
        : '\n' + fails + ' CHECK(S) FAILED');
    process.exit(fails === 0 ? 0 : 1);
});
