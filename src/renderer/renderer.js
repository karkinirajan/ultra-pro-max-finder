// The main window. Everything that comes from the user, the disk or the Google Sheet is put on the page
// with textContent and attributes, never as HTML: the old code built rows with template strings and
// innerHTML, so an account name or a template containing markup became live markup.
(() => {
  'use strict';

  const api = window.api;
  const mainBody = document.getElementById('mainBody');
  const noticeBox = document.getElementById('notice');
  let page = 'none';
  let selectedAccount = null;

  // ---------------------------------------------------------------------------------- helpers
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('data-') || key.startsWith('aria-')) node.setAttribute(key, value);
      else node[key] = value;
    }
    node.append(...children);
    return node;
  }

  const byId = (id) => document.getElementById(id);

  function mount(templateId) {
    mainBody.replaceChildren(byId(templateId).content.cloneNode(true));
  }

  function cleanError(error) {
    // Electron prefixes errors that crossed the IPC boundary.
    return String(error?.message ?? error).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      '',
    );
  }

  function notify(text, kind = 'success') {
    const alert = el('div', {
      class: `alert alert-${kind}`,
      role: kind === 'danger' ? 'alert' : 'status',
      text,
    });
    noticeBox.append(alert);
    setTimeout(() => alert.remove(), kind === 'danger' ? 12000 : 5000);
  }

  async function guarded(task) {
    try {
      return await task();
    } catch (error) {
      notify(cleanError(error), 'danger');
      return undefined;
    }
  }

  // ------------------------------------------------------------------------------ add account
  function showAddAccount() {
    page = 'add';
    mount('tpl-add');
    byId('loginForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const username = byId('username').value.trim();
      const password = byId('password').value;
      guarded(async () => {
        const result = await api.accounts.login(username, password);
        byId('password').value = '';
        notify(
          result.storesPassword
            ? 'LinkedIn is opening below. Sign in is filled in for you; the password is kept encrypted.'
            : 'LinkedIn is opening below. This computer cannot encrypt passwords, so yours is not kept: you will sign in again when the session expires.',
          'info',
        );
      });
    });
    byId('passwordHint').textContent =
      'The password is only sent to linkedin.com. It is stored encrypted by the operating system, or not at all.';
  }

  // ------------------------------------------------------------------------------- accounts
  function runLabel(account) {
    return account.running ? 'Running…' : 'Run now';
  }

  function accountRow(account) {
    const run = el('button', {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      text: runLabel(account),
    });
    run.disabled = account.running;
    run.addEventListener('click', () =>
      guarded(async () => {
        run.disabled = true;
        run.textContent = 'Running…';
        const result = await api.run.now(account.username);
        notify(
          result.alreadyRunning
            ? 'A run for this account is already in progress.'
            : `Found ${result.found} request(s); ${result.written} written to the sheet.` +
                (result.error ? `\n${result.error}` : '') +
                (result.note ? `\n${result.note}` : ''),
          result.error ? 'warning' : 'success',
        );
        await showAccounts();
      }).finally(() => {
        run.disabled = false;
        run.textContent = 'Run now';
      }),
    );

    const settings = el(
      'button',
      {
        class: 'btn btn-outline-primary btn-sm',
        type: 'button',
        title: 'Schedule',
        'aria-label': `Schedule for ${account.username}`,
      },
      el('i', { class: 'material-icons', text: 'settings' }),
    );
    settings.addEventListener('click', () => guarded(() => api.schedule.open(account.username)));

    const remove = el(
      'button',
      {
        class: 'btn btn-danger btn-sm',
        type: 'button',
        title: 'Remove',
        'aria-label': `Remove ${account.username}`,
      },
      el('i', { class: 'material-icons', text: 'delete' }),
    );
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${account.username} and its saved LinkedIn session?`)) return;
      guarded(async () => {
        await api.accounts.remove(account.username);
        if (selectedAccount === account.username) selectedAccount = null;
        notify('Account removed.');
      });
    });

    const name = el('td', { class: 'account-name', text: account.username, tabIndex: 0 });
    const select = () => {
      selectedAccount = account.username;
      document
        .querySelectorAll('#accountsBody tr')
        .forEach((row) =>
          row.classList.toggle('selected', row.dataset.username === account.username),
        );
      loadSheet(account.username);
    };
    name.addEventListener('click', select);
    name.addEventListener('keydown', (event) => event.key === 'Enter' && select());

    const row = el(
      'tr',
      {},
      name,
      el(
        'td',
        {},
        run,
        el('span', {
          class: 'ms-2 text-muted small',
          text: account.scheduled ? 'Scheduled' : 'Not scheduled',
        }),
      ),
      el('td', {}, settings, ' ', remove),
    );
    row.dataset.username = account.username;
    if (account.username === selectedAccount) row.classList.add('selected');
    return row;
  }

  function renderSheet(rows, emptyText) {
    const table = byId('sheetTable');
    if (!table) return;
    if (!rows.length) {
      table.replaceChildren(el('tbody', {}, el('tr', {}, el('td', { text: emptyText }))));
      return;
    }
    const headers = Object.keys(rows[0]);
    const head = el('thead', {}, el('tr', {}, ...headers.map((name) => el('th', { text: name }))));
    const body = el(
      'tbody',
      {},
      ...rows.map((row) =>
        el(
          'tr',
          {},
          ...headers.map((name) =>
            el('td', { class: 'cell-clamp', title: row[name] ?? '', text: row[name] ?? '' }),
          ),
        ),
      ),
    );
    table.replaceChildren(head, body);
  }

  async function loadSheet(username) {
    const heading = byId('sheetHeading');
    if (heading) heading.textContent = `Saved requests (${username})`;
    const result = await api.sheet.read(username);
    if (page !== 'accounts' || selectedAccount !== username) return;
    if (result.ok) return renderSheet(result.rows, 'No saved requests yet.');
    // A state of the setup, not an event: shown in place, so it does not pile up as notices.
    const messages = {
      'no-sheet': 'No Google Sheet link saved yet (Proposals page).',
      forbidden:
        'The app has no permission to open the Google Sheet. Share it with the service account, or change the link.',
      'missing-tab': 'No saved requests found.',
    };
    renderSheet(
      [],
      messages[result.reason] ?? result.message ?? 'The saved requests could not be read.',
    );
  }

  async function showAccounts() {
    page = 'accounts';
    mount('tpl-accounts');
    const accounts = (await guarded(() => api.accounts.list())) ?? [];
    const tbody = byId('accountsBody');
    if (!accounts.length) {
      tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 3, text: 'No accounts added' })));
      renderSheet([], 'No saved requests found.');
      return;
    }
    if (!accounts.some((a) => a.username === selectedAccount))
      selectedAccount = accounts[0].username;
    tbody.replaceChildren(...accounts.map(accountRow));
    await loadSheet(selectedAccount);
  }

  // ------------------------------------------------------------------------------- proposals
  async function showProposals() {
    page = 'proposals';
    mount('tpl-proposals');
    const data = await guarded(() => api.templates.get());
    if (!data) return;
    const select = byId('savedTemplate');
    const titles = Object.keys(data.proposals);
    select.replaceChildren(...titles.map((title) => el('option', { value: title, text: title })));
    const showSelected = () => {
      byId('savedTemplateText').textContent = data.proposals[select.value] ?? '';
    };
    select.addEventListener('change', showSelected);
    showSelected();
    byId('sheetUrl').value = data.sheetUrl;
    byId('savedMessage').textContent = data.message;

    byId('proposalForm').addEventListener('submit', (event) => {
      event.preventDefault();
      guarded(async () => {
        await api.templates.saveProposal(byId('templateTitle').value, byId('templateText').value);
        notify('Template saved.');
        await showProposals();
      });
    });
    byId('editTemplate').addEventListener('click', () => {
      if (!select.value) return notify('No saved template found.', 'warning');
      byId('templateTitle').value = select.value;
      byId('templateText').value = data.proposals[select.value];
    });
    byId('deleteTemplate').addEventListener('click', () => {
      if (!select.value) return notify('No saved template found.', 'warning');
      if (!confirm(`Delete the template "${select.value}"?`)) return;
      guarded(async () => {
        await api.templates.deleteProposal(select.value);
        notify('Template deleted.');
        await showProposals();
      });
    });

    byId('sheetForm').addEventListener('submit', (event) => {
      event.preventDefault();
      guarded(async () => {
        await api.templates.saveSheetUrl(byId('sheetUrl').value);
        notify('Link saved.');
      });
    });

    byId('messageForm').addEventListener('submit', (event) => {
      event.preventDefault();
      guarded(async () => {
        await api.templates.saveMessage(byId('messageText').value);
        notify('Message saved.');
        await showProposals();
      });
    });
    byId('editMessage').addEventListener('click', () => {
      if (!data.message) return notify('No saved message found.', 'warning');
      byId('messageText').value = data.message;
    });
    byId('deleteMessage').addEventListener('click', () => {
      if (!data.message) return notify('No saved message found.', 'warning');
      if (!confirm('Delete the follow-up message?')) return;
      guarded(async () => {
        await api.templates.saveMessage('');
        notify('Message deleted.');
        await showProposals();
      });
    });
  }

  // ------------------------------------------------------------------------------------ wiring
  const navigate = (show) => (event) => {
    event.preventDefault();
    show();
  };
  byId('nav-add').addEventListener('click', navigate(showAddAccount));
  byId('nav-accounts').addEventListener('click', navigate(showAccounts));
  byId('nav-proposals').addEventListener('click', navigate(showProposals));

  api.accounts.onChanged(() => {
    if (page === 'accounts') showAccounts();
  });
  api.run.onDone((username) => {
    if (page === 'accounts' && selectedAccount === username) loadSheet(username);
  });

  showAccounts();
})();
