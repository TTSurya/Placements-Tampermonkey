// ==UserScript==
// @name         IITM Placement – Company & Role Filters
// @namespace    https://placement.iitm.ac.in/
// @version      2.4
// @description  Status filters, company/role hiding, deadline sorting and compact links.
// @match        https://placement.iitm.ac.in/students-all-companies*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_PREFIX = 'iitmCompanyFiltersV2:';
  const BAR_ID = 'iitm-company-filter-bar';
  const STYLE_ID = 'iitm-company-filter-style';
  const STATUS_NAMES = ['Ineligible', 'Applied', 'Closed', 'Yet To Open'];
  const OBSERVER_OPTIONS = { childList: true, subtree: true };

  const MONTHS = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (_) {}
  }

  const savedStatuses = loadJSON('statuses', null);
  const hiddenStatuses = {};

  // Migrate the original script's preference: "1" meant show ineligible.
  let legacyShowIneligible = null;
  try {
    const value = localStorage.getItem('iitmShowIneligible');
    if (value !== null) legacyShowIneligible = value === '1';
  } catch (_) {}

  for (const status of STATUS_NAMES) {
    if (savedStatuses &&
        Object.prototype.hasOwnProperty.call(savedStatuses, status)) {
      hiddenStatuses[status] = savedStatuses[status] === true;
    } else if (status === 'Ineligible' && legacyShowIneligible !== null) {
      hiddenStatuses[status] = !legacyShowIneligible;
    } else {
      hiddenStatuses[status] = status === 'Ineligible';
    }
  }

  const savedCompanies = loadJSON('companies', []);
  const manuallyHidden = new Set(
    Array.isArray(savedCompanies)
      ? savedCompanies.filter(v => typeof v === 'string')
      : []
  );

  const savedRoles = loadJSON('roles', []);
  const manuallyHiddenRoles = new Set(
    Array.isArray(savedRoles)
      ? savedRoles.filter(v => typeof v === 'string')
      : []
  );

  let revealManuallyHidden = false;
  let observer = null;
  let scheduled = false;
  let running = false;

  // ------------------------------------------------------------------
  // STYLES
  // ------------------------------------------------------------------

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;

    style.textContent = `
      tr.iitm-filter-hidden {
        display: none !important;
      }

      tr.iitm-manual-revealed td:not(.iitm-hide-cell) {
        background: #f3f3f3 !important;
        color: #777 !important;
      }

      #${BAR_ID} {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin: 12px 0;
        padding: 10px 14px;
        border-radius: 8px;
        background: #f6f1e9;
        border: 1px solid #e6d6bd;
        color: #5a4a32;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.5;
      }

      #${BAR_ID} .iitm-filter-title {
        font-weight: 700;
      }

      #${BAR_ID} label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        cursor: pointer;
      }

      #${BAR_ID} button {
        border: 1px solid #c9a46a;
        background: #fff;
        color: #7a5520;
        border-radius: 6px;
        padding: 4px 9px;
        cursor: pointer;
        font-family: inherit;
        font-size: inherit;
      }

      #${BAR_ID} button:hover {
        background: #fbf3e6;
      }

      table.iitm-companies th {
        padding: 0 !important;
      }

      table.iitm-companies th .th-inner {
        padding: 10px 6px !important;
        white-space: normal !important;
      }

      table.iitm-companies td {
        padding: 8px 6px !important;
        white-space: normal !important;
      }

      table.iitm-companies .iitm-narrow {
        width: 1%;
        text-align: center;
        white-space: nowrap !important;
      }

      table.iitm-companies th.iitm-hide-cell,
      table.iitm-companies td.iitm-hide-cell {
        width: 62px !important;
        min-width: 62px;
        max-width: 62px;
        text-align: center !important;
        vertical-align: middle;
      }

      table.iitm-companies .iitm-hide-cell input {
        width: 15px;
        height: 15px;
        cursor: pointer;
        margin: 0;
      }

      a.iitm-pill {
        display: inline-block;
        padding: 2px 9px;
        border-radius: 999px;
        font-size: 12px;
        line-height: 18px;
        text-decoration: none !important;
        border: 1px solid currentColor;
        white-space: nowrap;
      }

      a.iitm-pill.link {
        color: #2f6fd6 !important;
      }

      a.iitm-pill.wa {
        color: #1f9d55 !important;
      }

      tr.bg-warning a.iitm-pill {
        color: #fff !important;
      }
    `;

    document.head.appendChild(style);
  }

  // ------------------------------------------------------------------
  // TABLE AND COLUMN DETECTION
  // Injected checkbox columns are excluded from all original indexes.
  // ------------------------------------------------------------------

  function originalHeaderCells(table) {
    if (!table.tHead || !table.tHead.rows.length) return [];

    return [...table.tHead.rows[0].cells].filter(
      th => !th.hasAttribute('data-iitm-hide-header')
    );
  }

  function originalCells(row) {
    return [...row.cells].filter(
      cell => !cell.hasAttribute('data-iitm-hide-cell')
    );
  }

  function cellAt(row, index) {
    if (index == null || index < 0) return null;
    return originalCells(row)[index] || null;
  }

  function findCompaniesTable() {
    return [...document.querySelectorAll('table')].find(table => {
      const headers = originalHeaderCells(table).map(th =>
        (th.dataset.iitmOrig || th.innerText || '')
          .trim()
          .toLowerCase()
      );

      return headers.includes('company name') &&
             headers.includes('action');
    });
  }

  function columnIndexes(table) {
    const indexes = {};

    originalHeaderCells(table).forEach((th, index) => {
      const name = (th.dataset.iitmOrig || th.innerText || '')
        .trim()
        .toLowerCase();

      if (name === 'credits') indexes.credits = index;
      else if (name === 'resume deadline') indexes.deadline = index;
      else if (name === 'company name') indexes.company = index;
      else if (name === 'external link') indexes.external = index;
      else if (name.replace(/\s/g, '') === 'whatsapplink') {
        indexes.whatsapp = index;
      }
      else if (name === 'action') indexes.action = index;
    });

    return indexes;
  }

  function normalizedText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function companyName(row, indexes) {
    return (cellAt(row, indexes.company)?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ------------------------------------------------------------------
  // STABLE COMPANY AND ROLE IDENTIFIERS
  // ------------------------------------------------------------------

  function companyKey(row, indexes) {
    const name = companyName(row, indexes);

    const id = row.getAttribute('data-company-id') ||
      row.getAttribute('data-uniqueid') ||
      row.id;

    if (id) return `id:${id}`;

    const link = cellAt(row, indexes.company)?.querySelector('a[href]');
    const href = link?.getAttribute('href');

    if (href) return `href:${href}`;

    return `name:${normalizedText(name)}`;
  }

  function statusOf(row, indexes) {
    return normalizedText(
      cellAt(row, indexes.action)?.innerText || ''
    );
  }

  function stableRoleId(row) {
    return row.getAttribute('data-role-id') ||
      row.getAttribute('data-job-id') ||
      row.getAttribute('data-position-id') ||
      row.getAttribute('data-record-id') ||
      '';
  }

  function roleDataFields(table, row, indexes) {
    const headers = originalHeaderCells(table);

    const ignored = new Set([
      indexes.company,
      indexes.action,
      indexes.credits,
      indexes.external,
      indexes.whatsapp,
      indexes.deadline
    ].filter(index => index != null));

    const fields = [];

    headers.forEach((header, index) => {
      if (ignored.has(index)) return;

      const heading = normalizedText(
        header.dataset.iitmOrig || header.innerText || ''
      );

      if (/^(s\.?\s*no\.?|serial(?:\s+number)?|#|credits?|resume\s+deadline|deadline|external\s+link|whatsapp(?:\s+link)?|action)$/.test(heading)) {
        return;
      }

      const value = normalizedText(
        cellAt(row, index)?.innerText || ''
      );

      if (value) {
        fields.push(
          `${heading || `column${index + 1}`}=${value.slice(0, 500)}`
        );
      }
    });

    // If no role/detail columns exist, use the other available row fields.
    if (!fields.length) {
      headers.forEach((header, index) => {
        if (index === indexes.company || index === indexes.action) return;

        const value = normalizedText(
          cellAt(row, index)?.innerText || ''
        );

        if (!value) return;

        const heading = normalizedText(
          header.dataset.iitmOrig || header.innerText || ''
        );

        fields.push(
          `${heading || `column${index + 1}`}=${value.slice(0, 500)}`
        );
      });
    }

    return fields.join('|');
  }

  function hashString(value) {
    let hash = 2166136261;

    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
  }

  function roleKey(row, table, indexes) {
    const company = companyKey(row, indexes);
    const id = stableRoleId(row);
    const signature = roleDataFields(table, row, indexes);

    return `role:${company}|${id ? `id:${normalizedText(id)}|` : ''}fields:${hashString(signature || company)}`;
  }

  function roleLabel(row, table, indexes) {
    const headers = originalHeaderCells(table);

    const pattern =
      /^(job\s+profile|profile|profile\s+name|role|role\s+name|job\s+role|job\s+title|title|designation|job\s+designation|position|position\s+title|position\s+offered|post|vacancy|opening)$/i;

    for (let index = 0; index < headers.length; index++) {
      const heading = (
        headers[index].dataset.iitmOrig ||
        headers[index].innerText ||
        ''
      ).trim();

      if (!pattern.test(heading)) continue;

      const value = (cellAt(row, index)?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (value) return value.slice(0, 140);
    }

    const fallback = roleDataFields(table, row, indexes);

    return fallback
      ? fallback.split('|').slice(0, 2).join(' · ').slice(0, 140)
      : 'role details';
  }

  // ------------------------------------------------------------------
  // DEADLINE SORTING
  // Company name first, so all roles from a company stay together.
  // Within each company: upcoming, past (newest first), then no deadline.
  // ------------------------------------------------------------------

  function deadlineOf(row, indexes) {
    const text = cellAt(row, indexes.deadline)?.textContent || '';

    const match = text.match(
      /([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/
    );

    if (!match ||
        !Object.prototype.hasOwnProperty.call(MONTHS, match[1])) {
      return NaN;
    }

    let hour = Number(match[4]) % 12;
    if (match[6] === 'PM') hour += 12;

    return new Date(
      Number(match[3]),
      MONTHS[match[1]],
      Number(match[2]),
      hour,
      Number(match[5])
    ).getTime();
  }

  function sortRows(tbody, indexes) {
    if (indexes.company == null || indexes.action == null) return;

    const rows = [...tbody.rows].filter(row =>
      cellAt(row, indexes.company) &&
      cellAt(row, indexes.action)
    );

    if (rows.length < 2) return;

    const originalOrder = [...rows];
    const now = Date.now();

    const keyed = rows.map((row, position) => {
      const deadline = deadlineOf(row, indexes);
      const name = companyName(row, indexes);

      return {
        row,
        position,
        normalizedName: normalizedText(name),
        deadline,
        group: Number.isNaN(deadline)
          ? 2
          : deadline >= now ? 0 : 1
      };
    });

    keyed.sort((a, b) =>
      a.normalizedName.localeCompare(
        b.normalizedName,
        undefined,
        { numeric: true }
      ) ||
      a.group - b.group ||
      (
        a.group === 0 ? a.deadline - b.deadline :
        a.group === 1 ? b.deadline - a.deadline : 0
      ) ||
      a.position - b.position
    );

    if (keyed.some((item, index) => item.row !== originalOrder[index])) {
      keyed.forEach(item => tbody.appendChild(item.row));
    }
  }

  // ------------------------------------------------------------------
  // COMPACT LINKS AND HEADERS
  // ------------------------------------------------------------------

  function shortLink(cell, className, label) {
    if (!cell || cell.dataset.iitmDone === '1') return;

    const anchor = cell.querySelector('a[href]');
    const url = (
      anchor ? anchor.getAttribute('href') : cell.textContent || ''
    ).trim();

    cell.dataset.iitmDone = '1';
    cell.classList.add('iitm-narrow');

    if (!/^https?:\/\//i.test(url)) {
      cell.textContent = '–';
      return;
    }

    cell.textContent = '';

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = `iitm-pill ${className}`;
    link.textContent = label;
    link.title = url;

    cell.appendChild(link);
  }

  function narrowHeader(header, abbreviatedText) {
    if (!header) return;

    if (!header.dataset.iitmOrig) {
      header.dataset.iitmOrig = (header.innerText || '').trim();
    }

    header.classList.add('iitm-narrow');

    const inner = header.querySelector('.th-inner') || header;

    if (inner.textContent !== abbreviatedText) {
      inner.textContent = abbreviatedText;
    }

    header.title = header.dataset.iitmOrig;
  }

  function setHeaderText(header, text, title) {
    if (header.textContent !== text) {
      header.textContent = text;
    }

    header.title = title;
  }

  // Idempotent: do not repeatedly move or rewrite already-correct cells.
  function ensureHideColumns(table) {
    const header = table.tHead?.rows[0];
    if (!header) return;

    let companyHeader =
      header.querySelector('th[data-iitm-company-hide-header]') ||
      [...header.querySelectorAll('th[data-iitm-hide-header]')]
        .find(th => !th.hasAttribute('data-iitm-role-hide-header'));

    if (!companyHeader) {
      companyHeader = document.createElement('th');
    }

    companyHeader.setAttribute('data-iitm-hide-header', 'company');
    companyHeader.setAttribute('data-iitm-company-hide-header', '1');
    companyHeader.classList.add('iitm-hide-cell');

    setHeaderText(
      companyHeader,
      'Hide Co.',
      'Tick to hide every role from this company'
    );

    let roleHeader =
      header.querySelector('th[data-iitm-role-hide-header]');

    if (!roleHeader) {
      roleHeader = document.createElement('th');
    }

    roleHeader.setAttribute('data-iitm-hide-header', 'role');
    roleHeader.setAttribute('data-iitm-role-hide-header', '1');
    roleHeader.classList.add('iitm-hide-cell');

    setHeaderText(
      roleHeader,
      'Hide Role',
      'Tick to hide only this role'
    );

    if (header.firstElementChild !== companyHeader) {
      header.insertBefore(
        companyHeader,
        header.firstElementChild || null
      );
    }

    if (companyHeader.nextElementSibling !== roleHeader) {
      header.insertBefore(roleHeader, companyHeader.nextElementSibling);
    }
  }

  function ensureCompanyAndRoleCells(row) {
    let companyCell =
      row.querySelector('td[data-iitm-company-hide-cell]') ||
      row.querySelector(
        'td[data-iitm-hide-cell]:not([data-iitm-role-hide-cell])'
      );

    if (!companyCell) {
      companyCell = document.createElement('td');
    }

    companyCell.setAttribute('data-iitm-hide-cell', 'company');
    companyCell.setAttribute('data-iitm-company-hide-cell', '1');
    companyCell.classList.add('iitm-hide-cell');

    let roleCell =
      row.querySelector('td[data-iitm-role-hide-cell]');

    if (!roleCell) {
      roleCell = document.createElement('td');
    }

    roleCell.setAttribute('data-iitm-hide-cell', 'role');
    roleCell.setAttribute('data-iitm-role-hide-cell', '1');
    roleCell.classList.add('iitm-hide-cell');

    if (row.firstElementChild !== companyCell) {
      row.insertBefore(companyCell, row.firstElementChild || null);
    }

    if (companyCell.nextElementSibling !== roleCell) {
      row.insertBefore(roleCell, companyCell.nextElementSibling);
    }

    return { companyCell, roleCell };
  }

  // ------------------------------------------------------------------
  // FILTER BAR
  // ------------------------------------------------------------------

  function ensureFilterBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;

    bar = document.createElement('div');
    bar.id = BAR_ID;

    const title = document.createElement('span');
    title.className = 'iitm-filter-title';
    title.textContent = 'Hide status:';
    bar.appendChild(title);

    for (const status of STATUS_NAMES) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');

      checkbox.type = 'checkbox';
      checkbox.checked = hiddenStatuses[status];
      checkbox.dataset.iitmStatusFilter = status;

      checkbox.addEventListener('change', () => {
        hiddenStatuses[status] = checkbox.checked;
        saveJSON('statuses', hiddenStatuses);
        apply();
      });

      label.append(checkbox, document.createTextNode(` ${status}`));
      bar.appendChild(label);
    }

    const reviewButton = document.createElement('button');
    reviewButton.type = 'button';
    reviewButton.dataset.iitmReviewButton = '1';

    reviewButton.addEventListener('click', () => {
      revealManuallyHidden = !revealManuallyHidden;
      apply();
    });

    bar.appendChild(reviewButton);

    const clearCompanies = document.createElement('button');
    clearCompanies.type = 'button';
    clearCompanies.textContent = 'Clear company hides';
    clearCompanies.title = 'Restore companies hidden using Hide Co.';

    clearCompanies.addEventListener('click', () => {
      manuallyHidden.clear();
      saveJSON('companies', []);
      revealManuallyHidden = false;
      apply();
    });

    bar.appendChild(clearCompanies);

    const clearRoles = document.createElement('button');
    clearRoles.type = 'button';
    clearRoles.textContent = 'Clear role hides';
    clearRoles.title = 'Restore roles hidden using Hide Role';

    clearRoles.addEventListener('click', () => {
      manuallyHiddenRoles.clear();
      saveJSON('roles', []);
      revealManuallyHidden = false;
      apply();
    });

    bar.appendChild(clearRoles);

    return bar;
  }

  // ------------------------------------------------------------------
  // APPLY FILTERS
  // ------------------------------------------------------------------

  function applyInternal() {
    const table = findCompaniesTable();

    if (!table || !table.tHead || !table.tBodies.length) return;

    table.classList.add('iitm-companies');
    ensureHideColumns(table);

    let indexes = columnIndexes(table);

    const headers = originalHeaderCells(table);

    narrowHeader(headers[indexes.credits], 'Cr.');
    narrowHeader(headers[indexes.external], 'Link');
    narrowHeader(headers[indexes.whatsapp], 'WhatsApp');

    indexes = columnIndexes(table);

    const tbody = table.tBodies[0];

    for (const row of [...tbody.rows]) {
      const nameCell = cellAt(row, indexes.company);
      const actionCell = cellAt(row, indexes.action);

      // Skip empty-state rows.
      if (!nameCell || !actionCell) continue;

      const name = companyName(row, indexes);
      if (!name) continue;

      const { companyCell, roleCell } =
        ensureCompanyAndRoleCells(row);

      // Company-level checkbox.
      let companyCheckbox =
        companyCell.querySelector('input[type="checkbox"]');

      if (!companyCheckbox) {
        companyCheckbox = document.createElement('input');
        companyCheckbox.type = 'checkbox';

        companyCheckbox.addEventListener('change', () => {
          const key = companyCheckbox.dataset.iitmCompanyKey;
          if (!key) return;

          if (companyCheckbox.checked) manuallyHidden.add(key);
          else manuallyHidden.delete(key);

          saveJSON('companies', [...manuallyHidden]);
          apply();
        });

        companyCell.appendChild(companyCheckbox);
      }

      const key = companyKey(row, indexes);

      companyCheckbox.dataset.iitmCompanyKey = key;
      companyCheckbox.checked = manuallyHidden.has(key);
      companyCheckbox.title = `Hide every role from ${name}`;
      companyCheckbox.setAttribute(
        'aria-label',
        `Hide every role from ${name}`
      );

      // Role-level checkbox.
      let roleCheckbox =
        roleCell.querySelector('input[type="checkbox"]');

      if (!roleCheckbox) {
        roleCheckbox = document.createElement('input');
        roleCheckbox.type = 'checkbox';

        roleCheckbox.addEventListener('change', () => {
          const role = roleCheckbox.dataset.iitmRoleKey;
          if (!role) return;

          if (roleCheckbox.checked) manuallyHiddenRoles.add(role);
          else manuallyHiddenRoles.delete(role);

          saveJSON('roles', [...manuallyHiddenRoles]);
          apply();
        });

        roleCell.appendChild(roleCheckbox);
      }

      const role = roleKey(row, table, indexes);
      const label = roleLabel(row, table, indexes);

      roleCheckbox.dataset.iitmRoleKey = role;
      roleCheckbox.checked = manuallyHiddenRoles.has(role);
      roleCheckbox.title = `Hide only this role: ${name} — ${label}`;

      roleCheckbox.setAttribute(
        'aria-label',
        `Hide role ${label} at ${name}`
      );

      if (indexes.credits != null) {
        cellAt(row, indexes.credits)?.classList.add('iitm-narrow');
      }

      if (indexes.external != null) {
        shortLink(cellAt(row, indexes.external), 'link', 'Open');
      }

      if (indexes.whatsapp != null) {
        shortLink(cellAt(row, indexes.whatsapp), 'wa', 'Join');
      }

      const statusText = statusOf(row, indexes);

      const matchingStatus = STATUS_NAMES.find(
        status => status.toLowerCase() === statusText
      );

      const hiddenByStatus =
        !!matchingStatus && hiddenStatuses[matchingStatus];

      const hiddenByCompany = manuallyHidden.has(key);
      const hiddenByRole = manuallyHiddenRoles.has(role);
      const manualHidden = hiddenByCompany || hiddenByRole;

      // Revealing manual hides temporarily makes those rows editable again.
      const reviewing = manualHidden && revealManuallyHidden;

      row.classList.toggle(
        'iitm-filter-hidden',
        (hiddenByStatus || manualHidden) && !reviewing
      );

      row.classList.toggle('iitm-manual-revealed', reviewing);
    }

    sortRows(tbody, indexes);

    const bar = ensureFilterBar();

    bar.querySelectorAll('input[data-iitm-status-filter]')
      .forEach(checkbox => {
        checkbox.checked =
          !!hiddenStatuses[checkbox.dataset.iitmStatusFilter];
      });

    const reviewButton = bar.querySelector(
      'button[data-iitm-review-button]'
    );

    if (reviewButton) {
      reviewButton.textContent = revealManuallyHidden
        ? 'Stop reviewing manual hides'
        : `Review manual hides (companies: ${manuallyHidden.size}, roles: ${manuallyHiddenRoles.size})`;

      reviewButton.title = revealManuallyHidden
        ? 'Hide manually hidden rows again'
        : 'Temporarily reveal manually hidden rows in grey';
    }

    const anchor = table.closest('.bootstrap-table') || table;

    if (anchor.parentNode && bar.nextElementSibling !== anchor) {
      anchor.parentNode.insertBefore(bar, anchor);
    }
  }

  // ------------------------------------------------------------------
  // OBSERVER: prevent the script's own DOM changes from retriggering apply.
  // This is the main fix for the flickering behavior.
  // ------------------------------------------------------------------

  function apply() {
    if (running) return;

    running = true;

    if (observer) observer.disconnect();

    try {
      applyInternal();
    } catch (error) {
      console.error('[IITM Company Filters] Error:', error);
    } finally {
      running = false;

      if (observer && document.body) {
        observer.observe(document.body, OBSERVER_OPTIONS);
      }
    }
  }

  observer = new MutationObserver(() => {
    if (scheduled) return;

    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  });

  observer.observe(document.body, OBSERVER_OPTIONS);
  apply();
})();
