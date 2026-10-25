// ==UserScript==
// @name         IITM Placement – Company Filters
// @namespace    https://placement.iitm.ac.in/
// @version      2.1
// @description  Independently filter company statuses, hide individual companies, sort resume deadlines, and compact links.
// @match        https://placement.iitm.ac.in/students-all-companies*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Change these keys only if you want to reset saved filters and hidden companies.
  const STORAGE_PREFIX = 'iitmCompanyFiltersV2:';
  const BAR_ID = 'iitm-company-filter-bar';
  const STYLE_ID = 'iitm-company-filter-style';
  const STATUS_NAMES = ['Ineligible', 'Applied', 'Closed', 'Yet To Open'];
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
    } catch (_) {
      // Filtering still works for this page if storage is unavailable.
    }
  }

  const savedStatuses = loadJSON('statuses', null);
  const hiddenStatuses = {};
  let legacyShowIneligible = null;
  try {
    const legacyValue = localStorage.getItem('iitmShowIneligible');
    if (legacyValue !== null) legacyShowIneligible = legacyValue === '1';
  } catch (_) {}

  for (const status of STATUS_NAMES) {
    if (savedStatuses && Object.prototype.hasOwnProperty.call(savedStatuses, status)) {
      hiddenStatuses[status] = savedStatuses[status] === true;
    } else if (status === 'Ineligible' && legacyShowIneligible !== null) {
      // Migrate the previous script's preference (1 meant show, not hide).
      hiddenStatuses[status] = !legacyShowIneligible;
    } else {
      hiddenStatuses[status] = status === 'Ineligible'; // Original default.
    }
  }

  const loadedCompanies = loadJSON('companies', []);
  const manuallyHidden = new Set(
    Array.isArray(loadedCompanies) ? loadedCompanies.filter(x => typeof x === 'string') : []
  );
  let revealManuallyHidden = false;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      tr.iitm-filter-hidden { display: none !important; }
      tr.iitm-manual-revealed td:not(.iitm-hide-cell) {
        background: #f3f3f3 !important;
        color: #777 !important;
      }
      #${BAR_ID} {
        display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
        margin: 12px 0; padding: 10px 14px; border-radius: 8px;
        background: #f6f1e9; border: 1px solid #e6d6bd; color: #5a4a32;
        font-family: inherit; font-size: 13px; line-height: 1.5;
      }
      #${BAR_ID} .iitm-filter-title { font-weight: 700; }
      #${BAR_ID} label {
        display: inline-flex; align-items: center; gap: 5px;
        white-space: nowrap; cursor: pointer;
      }
      #${BAR_ID} button {
        border: 1px solid #c9a46a; background: #fff; color: #7a5520;
        border-radius: 6px; padding: 4px 9px; cursor: pointer;
        font: inherit;
      }
      #${BAR_ID} button:hover { background: #fbf3e6; }
      table.iitm-companies th { padding: 0 !important; }
      table.iitm-companies th .th-inner {
        padding: 10px 6px !important; white-space: normal !important;
      }
      table.iitm-companies td {
        padding: 8px 6px !important; white-space: normal !important;
      }
      table.iitm-companies .iitm-narrow {
        width: 1%; text-align: center; white-space: nowrap !important;
      }
      table.iitm-companies th.iitm-hide-cell,
      table.iitm-companies td.iitm-hide-cell {
        width: 34px !important; min-width: 34px; max-width: 34px;
        text-align: center !important; vertical-align: middle;
      }
      table.iitm-companies .iitm-hide-cell input {
        width: 15px; height: 15px; cursor: pointer; margin: 0;
      }
      a.iitm-pill {
        display: inline-block; padding: 2px 9px; border-radius: 999px;
        font-size: 12px; line-height: 18px; text-decoration: none !important;
        border: 1px solid currentColor; white-space: nowrap;
      }
      a.iitm-pill.link { color: #2f6fd6 !important; }
      a.iitm-pill.wa { color: #1f9d55 !important; }
      tr.bg-warning a.iitm-pill { color: #fff !important; }
    `;
    document.head.appendChild(style);
  }

  // Always work with the portal's original cells. The injected checkbox column
  // is deliberately excluded, so all original indexes remain stable.
  function originalHeaderCells(table) {
    if (!table.tHead || !table.tHead.rows.length) return [];
    return [...table.tHead.rows[0].cells].filter(th => !th.hasAttribute('data-iitm-hide-header'));
  }

  function originalCells(row) {
    return [...row.cells].filter(cell => !cell.hasAttribute('data-iitm-hide-cell'));
  }

  function cellAt(row, logicalIndex) {
    if (logicalIndex == null || logicalIndex < 0) return null;
    return originalCells(row)[logicalIndex] || null;
  }

  function findCompaniesTable() {
    return [...document.querySelectorAll('table')].find(table => {
      const headers = originalHeaderCells(table).map(th =>
        (th.dataset.iitmOrig || th.innerText || '').trim().toLowerCase()
      );
      return headers.includes('company name') && headers.includes('action');
    });
  }

  function columnIndexes(table) {
    const indexes = {};
    originalHeaderCells(table).forEach((th, i) => {
      const name = (th.dataset.iitmOrig || th.innerText || '').trim().toLowerCase();
      if (name === 'credits') indexes.credits = i;
      else if (name === 'resume deadline') indexes.deadline = i;
      else if (name === 'company name') indexes.company = i;
      else if (name === 'external link') indexes.external = i;
      else if (name.replace(/\s/g, '') === 'whatsapplink') indexes.whatsapp = i;
      else if (name === 'action') indexes.action = i;
    });
    return indexes;
  }

  function companyName(row, indexes) {
    return (cellAt(row, indexes.company)?.innerText || '').replace(/\s+/g, ' ').trim();
  }

  // Prefer a stable portal identifier if one exists; fall back to the company
  // name. This key is independent of the current sort order/page row position.
  function companyKey(row, indexes) {
    const name = companyName(row, indexes);
    const stableId = row.getAttribute('data-uniqueid') ||
      row.getAttribute('data-company-id') || row.id;
    if (stableId) return `id:${stableId}`;

    const nameCell = cellAt(row, indexes.company);
    const nameLink = nameCell?.querySelector('a[href]');
    const href = nameLink?.getAttribute('href');
    if (href) return `href:${href}`;

    return `name:${name.toLocaleLowerCase()}`;
  }

  function statusOf(row, indexes) {
    return (cellAt(row, indexes.action)?.innerText || '')
      .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  }

  function deadlineOf(row, indexes) {
    const text = cellAt(row, indexes.deadline)?.textContent || '';
    const match = text.match(
      /([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/
    );
    if (!match || !Object.prototype.hasOwnProperty.call(MONTHS, match[1])) return NaN;

    let hour = Number(match[4]) % 12;
    if (match[6] === 'PM') hour += 12;
    return new Date(
      Number(match[3]), MONTHS[match[1]], Number(match[2]), hour, Number(match[5])
    ).getTime();
  }

  function sortRows(tbody, indexes) {
    if (indexes.deadline == null || indexes.company == null || indexes.action == null) return;

    // Leave non-company/placeholder rows alone.
    const rows = [...tbody.rows].filter(row =>
      cellAt(row, indexes.company) && cellAt(row, indexes.action)
    );
    const originalOrder = [...rows];
    const now = Date.now();
    const keyed = rows.map((row, position) => {
      const deadline = deadlineOf(row, indexes);
      return {
        row,
        position,
        deadline,
        group: Number.isNaN(deadline) ? 2 : deadline >= now ? 0 : 1,
        name: companyName(row, indexes)
      };
    });

    keyed.sort((a, b) =>
      a.group - b.group ||
      (a.group === 0 ? a.deadline - b.deadline :
       a.group === 1 ? b.deadline - a.deadline : 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
      a.position - b.position
    );

    if (keyed.some((item, i) => item.row !== originalOrder[i])) {
      keyed.forEach(item => tbody.appendChild(item.row));
    }
  }

  function shortLink(cell, className, label) {
    if (!cell || cell.dataset.iitmDone === '1') return;

    const anchor = cell.querySelector('a[href]');
    const url = (anchor ? anchor.getAttribute('href') : cell.textContent || '').trim();
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

  function narrowHeader(th, abbreviatedText) {
    if (!th || th.dataset.iitmOrig) return;
    th.dataset.iitmOrig = (th.innerText || '').trim();
    th.classList.add('iitm-narrow');
    const inner = th.querySelector('.th-inner') || th;
    inner.textContent = abbreviatedText;
    th.title = th.dataset.iitmOrig;
  }

  function ensureHideColumn(table) {
    const header = table.tHead?.rows[0];
    if (!header) return;

    if (!header.querySelector('th[data-iitm-hide-header]')) {
      const th = document.createElement('th');
      th.setAttribute('data-iitm-hide-header', '1');
      th.className = 'iitm-hide-cell';
      th.textContent = 'Hide';
      th.title = 'Tick a checkbox to hide that company';
      header.insertBefore(th, header.cells[0] || null);
    }
  }

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

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = 'Clear individual hides';
    clearButton.title = 'Unhide every company hidden with its row checkbox';
    clearButton.addEventListener('click', () => {
      manuallyHidden.clear();
      saveJSON('companies', []);
      revealManuallyHidden = false;
      apply();
    });
    bar.appendChild(clearButton);

    return bar;
  }

  function apply() {
    const table = findCompaniesTable();
    if (!table || !table.tHead || !table.tBodies.length) return;

    table.classList.add('iitm-companies');
    ensureHideColumn(table);

    let indexes = columnIndexes(table);
    const originalHeaders = originalHeaderCells(table);
    narrowHeader(originalHeaders[indexes.credits], 'Cr.');
    narrowHeader(originalHeaders[indexes.external], 'Link');
    narrowHeader(originalHeaders[indexes.whatsapp], 'WhatsApp');
    indexes = columnIndexes(table);

    const tbody = table.tBodies[0];
    for (const row of [...tbody.rows]) {
      // Skip empty-state rows and any non-company rows.
      const nameCell = cellAt(row, indexes.company);
      const actionCell = cellAt(row, indexes.action);
      if (!nameCell || !actionCell) continue;

      const name = companyName(row, indexes);
      if (!name) continue;

      let checkboxCell = row.querySelector('td[data-iitm-hide-cell]');
      if (!checkboxCell) {
        checkboxCell = document.createElement('td');
        checkboxCell.setAttribute('data-iitm-hide-cell', '1');
        checkboxCell.className = 'iitm-hide-cell';
        row.insertBefore(checkboxCell, row.cells[0] || null);
      } else {
        checkboxCell.classList.add('iitm-hide-cell');
      }

      let checkbox = checkboxCell.querySelector('input[type="checkbox"]');
      if (!checkbox) {
        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => {
          const key = checkbox.dataset.iitmCompanyKey;
          if (!key) return;
          if (checkbox.checked) manuallyHidden.add(key);
          else manuallyHidden.delete(key);
          saveJSON('companies', [...manuallyHidden]);
          apply();
        });
        checkboxCell.appendChild(checkbox);
      }

      const key = companyKey(row, indexes);
      checkbox.dataset.iitmCompanyKey = key;
      checkbox.checked = manuallyHidden.has(key);
      checkbox.title = `Tick to hide: ${name}`;
      checkbox.setAttribute('aria-label', `Hide ${name}`);

      if (indexes.credits != null) cellAt(row, indexes.credits)?.classList.add('iitm-narrow');
      if (indexes.external != null) shortLink(cellAt(row, indexes.external), 'link', 'Open');
      if (indexes.whatsapp != null) shortLink(cellAt(row, indexes.whatsapp), 'wa', 'Join');

      const statusText = statusOf(row, indexes);
      const matchingStatus = STATUS_NAMES.find(status =>
        status.toLocaleLowerCase() === statusText
      );
      const hiddenByStatus = !!matchingStatus && hiddenStatuses[matchingStatus];
      const hiddenByPerson = manuallyHidden.has(key);
      // Review mode temporarily reveals manually hidden rows, even if their
      // status is filtered, so the user can untick the individual checkbox.
      const reviewingThisRow = hiddenByPerson && revealManuallyHidden;
      const isHidden = (hiddenByStatus || hiddenByPerson) && !reviewingThisRow;

      row.classList.toggle('iitm-filter-hidden', isHidden);
      row.classList.toggle('iitm-manual-revealed', reviewingThisRow);
    }

    sortRows(tbody, indexes);

    const bar = ensureFilterBar();
    // Keep checkbox UI synchronized with saved settings if the bar is reused.
    bar.querySelectorAll('input[data-iitm-status-filter]').forEach(checkbox => {
      checkbox.checked = !!hiddenStatuses[checkbox.dataset.iitmStatusFilter];
    });
    const reviewButton = bar.querySelector('button[data-iitm-review-button]');
    if (reviewButton) {
      const reviewText = revealManuallyHidden
        ? 'Stop reviewing hidden companies'
        : `Review individual hides (${manuallyHidden.size})`;
      // Avoid replacing the text node on every observer pass.
      if (reviewButton.textContent !== reviewText) reviewButton.textContent = reviewText;
      reviewButton.title = revealManuallyHidden
        ? 'Hide manually hidden companies again'
        : 'Temporarily show manually hidden companies in grey';
    }

    const anchor = table.closest('.bootstrap-table') || table;
    if (anchor.parentNode && bar.nextElementSibling !== anchor) {
      anchor.parentNode.insertBefore(bar, anchor);
    }
  }

  // The portal may rebuild the table after search, pagination, or sorting.
  // The code above is idempotent: injected headers/cells and shortened links
  // are detected, so observer callbacks settle instead of endlessly re-writing.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  apply();
})();
