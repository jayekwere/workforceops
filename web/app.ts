const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
let token = '',
  roleList: string[] = [];
function el(tag: string, text = '', className = '') {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = className;
  return n;
}
function notice(message: string, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
function failure(e: unknown) {
  notice(e instanceof Error ? e.message : 'Request failed', true);
}
async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
function badge(text: string) {
  return el('span', text, 'badge state-' + text);
}
function addCell(row: HTMLElement, text: string, cls = '') {
  const n = el('td', text, cls);
  row.append(n);
  return n;
}
function option(select: HTMLElement, id: string, label: string) {
  const node = el('option', label) as HTMLOptionElement;
  node.value = id;
  select.append(node);
}
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function audit(events: any[]) {
  const root = $('audit');
  root.replaceChildren();
  for (const event of events.slice(0, 8)) {
    const row = el('tr');
    addCell(row, new Date(event.at).toLocaleTimeString([], { hour12: false }), 'mono');
    addCell(row, event.actor);
    const c = addCell(row, '');
    c.append(el('b', event.action), el('small', '#' + event.seq + ' · ' + event.hash.slice(0, 10)));
    root.append(row);
  }
  if (!events.length) {
    const row = el('tr');
    const c = addCell(row, 'No recorded activity.');
    c.setAttribute('colspan', '3');
    root.append(row);
  }
}
function button(label: string, action: () => Promise<unknown>, cls = 'ghost') {
  const b = el('button', label, cls) as HTMLButtonElement;
  b.onclick = () => {
    b.disabled = true;
    void action()
      .catch(failure)
      .finally(() => {
        b.disabled = false;
      });
  };
  return b;
}
async function mutate(path: string, body: unknown, message: string) {
  const result = await api(path, 'POST', body);
  notice(message);
  await refresh();
  return result;
}
$('connect').onclick = () => {
  token = value('token');
  void api('/api/me')
    .then(async (me) => {
      roleList = me.roles;
      $('status').textContent = me.subject + ' · ' + me.roles.join(', ');
      notice('Connected to ' + me.tenant + '. Your role controls the actions available here.');
      await refresh();
    })
    .catch(failure);
};
$('refresh').onclick = () => void refresh().catch(failure);
function approvals(plans: any[], extra?: (p: any, container: HTMLElement) => void) {
  const root = $('plans');
  root.replaceChildren();
  if (!plans.length) {
    root.className = 'empty';
    root.textContent = 'No plans created yet.';
    return;
  }
  root.className = '';
  for (const p of plans) {
    const record = el('article', '', 'record');
    record.dataset.planId = p.id;
    const top = el('header');
    top.append(el('h3', planTitle(p)), badge(p.status));
    record.append(
      top,
      el(
        'p',
        'Requested by ' +
          p.binding.requestedBy +
          ' · ' +
          new Date(p.binding.expiresAt).toLocaleTimeString() +
          ' expiry',
      ),
      el('p', p.digest, 'evidence'),
    );
    const actions = el('div', '', 'row-actions');
    if (roleList.includes('reviewer') && p.status === 'planned') {
      actions.append(
        button(
          'Approve',
          () =>
            mutate(
              '/api/plans/' + p.id + '/review',
              { digest: p.digest, approve: true },
              'Approval granted for this exact plan.',
            ),
          'primary',
        ),
        button('Reject', () =>
          mutate(
            '/api/plans/' + p.id + '/review',
            { digest: p.digest, approve: false },
            'Plan rejected.',
          ),
        ),
      );
    }
    if (roleList.includes('operator') && ['approved', 'blocked'].includes(p.status))
      actions.append(
        button(
          p.status === 'blocked' ? 'Retry known blocked step' : 'Execute',
          () =>
            mutate(
              '/api/plans/' + p.id + '/execute',
              { digest: p.digest, key: p.executionKey ?? 'execute-' + p.id },
              'Execution recorded. Inspect the result and any remaining work.',
            ),
          'primary',
        ),
      );
    actions.append(button('Export evidence', async () => download(p, 'plan-evidence.json')));
    record.append(actions);
    extra?.(p, record);
    root.append(record);
  }
}

function planTitle(p: any) {
  return p.binding.data.action + ' · ' + p.binding.data.employee.name;
}
async function refresh() {
  const d = await api('/api/overview');
  $<HTMLButtonElement>('create-plan').disabled = !roleList.includes('requester');
  for (const id of ['pause', 'restore'])
    $<HTMLButtonElement>(id).disabled = !roleList.includes('operator');
  $<HTMLButtonElement>('drift').disabled = !roleList.some((r) =>
    ['viewer', 'operator'].includes(r),
  );
  $('people-count').textContent = String(d.employees.length);
  $('provider-count').textContent = String(d.providers.length);
  $('pending-count').textContent = String(
    d.plans.filter((p: any) => p.status === 'planned').length,
  );
  $('complete-count').textContent = String(
    d.plans.filter((p: any) => p.status === 'completed').length,
  );
  const rows = $('employees');
  rows.replaceChildren();
  const select = $('employee');
  const previous = value('employee');
  select.replaceChildren();
  for (const e of d.employees) {
    const r = el('tr');
    const c = addCell(r, '');
    c.append(el('b', e.name), el('small', e.email));
    addCell(r, e.department);
    addCell(r, e.employment);
    addCell(r, e.id, 'mono');
    rows.append(r);
    option(select, e.id, e.name);
  }
  if (previous) $<HTMLSelectElement>('employee').value = previous;
  else $<HTMLSelectElement>('employee').value = 'worker-003';
  const providers = $('providers');
  providers.replaceChildren();
  for (const p of d.providers) providers.append(badge(p.alias + ' · ' + p.mode));
  approvals(d.plans, (p, record) => {
    if (p.result) {
      const results = el('div');
      for (const step of p.result.steps ?? []) {
        const line = el('div', '', 'metric-row');
        line.append(el('span', step.provider), badge(step.status));
        results.append(line);
      }
      if (p.result.manualTasks?.length) {
        for (const [index, t] of p.result.manualTasks.entries()) {
          results.append(el('p', t.title + ' · ' + t.status));
          if (roleList.includes('operator') && p.status === 'completed' && t.status === 'open')
            results.append(
              button('Record review: ' + t.title, () =>
                mutate(
                  '/api/plans/' + p.id + '/manual-task',
                  {
                    index,
                    decision: 'completed',
                    note: 'Operator explicitly reviewed this manual decision in the workbench.',
                  },
                  'Operator attestation recorded. This does not verify a physical equipment return.',
                ),
              ),
            );
        }
      }
      record.append(results);
    }
    if (roleList.includes('operator') && p.status === 'uncertain')
      record.append(
        button('Read-only reconciliation', () =>
          mutate(
            '/api/plans/' + p.id + '/reconcile',
            {},
            'Readback recorded. No write was retried.',
          ),
        ),
      );
    if (roleList.includes('operator') && p.status === 'blocked')
      record.append(
        button('Cancel blocked operation', () =>
          mutate(
            '/api/plans/' + p.id + '/cancel',
            {},
            'Known blocked operation cancelled. A new plan can be reviewed.',
          ),
        ),
      );
  });
  audit(d.audit);
  $('fault').hidden = !d.providers.some((p: any) => p.mode === 'local-scim');
}
$('create-plan').onclick = () =>
  void mutate(
    '/api/plans',
    {
      employeeId: value('employee'),
      action: value('operation'),
      ...(value('operation') === 'change-role' ? { department: value('department') } : {}),
    },
    'Plan created. Connect an independent reviewer to approve it.',
  ).catch(failure);
$('drift').onclick = () =>
  void api('/api/drift')
    .then((d) => {
      $('drift-results').textContent = JSON.stringify(d, null, 2);
    })
    .catch(failure);
for (const [id, unavailable] of [
  ['pause', true],
  ['restore', false],
] as const)
  $(id).onclick = () =>
    void mutate(
      '/api/demo/fault',
      { provider: 'collaboration', unavailable },
      unavailable ? 'Local collaboration service paused.' : 'Local collaboration service restored.',
    ).catch(failure);

$('disconnect').onclick = () => {
  token = '';
  roleList = [];
  location.reload();
};
