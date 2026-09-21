/**
 * Kenitra City School - Student & Book Finder
 * Two-page navigation controller: Search Page (Page 1) -> Result Page (Page 2)
 */

(function () {
  'use strict';

  if (window.__APP_RUNNING__) return;
  window.__APP_RUNNING__ = true;

  // Elements
  const pageSearch = document.getElementById('page-search');
  const pageResult = document.getElementById('page-result');
  const studentInput = document.getElementById('student-name');
  const suggestionsBox = document.getElementById('suggestions');
  const classFilter = document.getElementById('class-filter');
  const findBtn = document.getElementById('find-btn');
  const noticeArea = document.getElementById('search-notice-area');
  const demoBanner = document.getElementById('demo-banner');

  // Page 2 Elements
  const resultNameEl = document.getElementById('p2-student-name');
  const resultClassEl = document.getElementById('p2-class-badge');
  const resultGroupEl = document.getElementById('p2-group-badge');
  const resultBookTitleEl = document.getElementById('p2-book-title');
  const resultBookCoverEl = document.getElementById('p2-book-cover');
  const btnBackSearch = document.getElementById('btn-back-to-search');
  const btnSearchAgainP2 = document.getElementById('btn-search-again-p2');

  // State
  let activeIndex = -1;
  let debounceTimer = null;
  let currentSuggestions = [];
  let isFetching = false;

  const BOOK_IMAGES = {
    "Kid's Box 1": "/img/kb1.jpg",
    "Kid's Box 2": "/img/kb2.jpg",
    "Kid's Box 3": "/img/kb3.jpg",
    "Kid's Box 4": "/img/kb4.jpg",
    "Kid's Box 5": "/img/kb5.jpg",
    "Kid's Box 6": "/img/kb6.jpg",
  };

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeText(str) {
    if (typeof str !== 'string') return '';
    let s = str.normalize('NFKC').toLowerCase();
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  function allTokensPrefix(qTokens, nameTokens) {
    if (qTokens.length === 0) return false;
    if (qTokens.length > nameTokens.length) return false;
    const used = new Array(nameTokens.length).fill(false);
    const assign = (qi) => {
      if (qi === qTokens.length) return true;
      for (let ni = 0; ni < nameTokens.length; ni++) {
        if (!used[ni] && nameTokens[ni].startsWith(qTokens[qi])) {
          used[ni] = true;
          if (assign(qi + 1)) return true;
          used[ni] = false;
        }
      }
      return false;
    };
    return assign(0);
  }

  function getBookCover(bookName) {
    if (window.__FALLBACK_COVERS__ && window.__FALLBACK_COVERS__[bookName]) {
      return window.__FALLBACK_COVERS__[bookName];
    }
    if (BOOK_IMAGES[bookName]) {
      return BOOK_IMAGES[bookName];
    }
    const match = bookName && bookName.match(/(\d)/);
    if (match) {
      return `/img/kb${match[1]}.jpg`;
    }
    return '/img/kb1.jpg';
  }

  // Two-page router: go to dedicated Result Page
  function navigateToResult(id) {
    const target = '/result.html?id=' + encodeURIComponent(id);

    try {
      // Prefer a root-relative route so the link works correctly on deployed or nested paths.
      window.location.assign(target);
      return;
    } catch (e) {
      // In sandbox mode, fall through to in-page view switch.
    }

    // In-page view switch (Page 1 -> Page 2)
    if (pageSearch && pageResult) {
      pageSearch.style.display = 'none';
      pageResult.style.display = 'block';
      window.scrollTo(0, 0);
      loadStudentIntoPage2(id);
    }
  }

  function backToSearch() {
    if (pageSearch && pageResult) {
      pageResult.style.display = 'none';
      pageSearch.style.display = 'block';
      clearNotices();
      if (studentInput) {
        studentInput.value = '';
        studentInput.focus();
      }
      window.scrollTo(0, 0);
    }
  }

  // Populate Page 2
  async function loadStudentIntoPage2(id) {
    let student = null;
    try {
      const res = await fetch(`/api/student?id=${encodeURIComponent(id)}`);
      if (res.ok) {
        student = await res.json();
      }
    } catch (e) {
      // offline
    }

    if (!student && Array.isArray(window.__FALLBACK_STUDENTS__)) {
      student = window.__FALLBACK_STUDENTS__.find((s) => s.id === id);
    }

    if (!student) {
      if (resultNameEl) resultNameEl.textContent = 'Student Not Found';
      return;
    }

    if (resultNameEl) resultNameEl.textContent = student.name;
    if (resultClassEl) resultClassEl.textContent = 'Class: ' + student.className;
    if (resultGroupEl) {
      const gNum = String(student.group).replace(/[^0-9]/g, '') || '1';
      resultGroupEl.textContent = 'Group ' + gNum;
    }
    if (resultBookTitleEl) resultBookTitleEl.textContent = student.book;

    if (resultBookCoverEl) {
      const coverUrl = getBookCover(student.book);
      resultBookCoverEl.src = coverUrl;
      resultBookCoverEl.alt = student.book + ' Cover';
    }
    document.title = `${student.name} - ${student.book} • Kenitra City School`;
  }

  // Initialize metadata
  async function init() {
    let classes = [];
    try {
      const res = await fetch('/api/meta');
      if (res.ok) {
        const meta = await res.json();
        classes = meta.classes || [];
        if (meta.demo && demoBanner) demoBanner.hidden = false;
        else if (demoBanner) demoBanner.hidden = true;
      }
    } catch (err) {
      classes = window.__FALLBACK_CLASSES__ || [];
      if (demoBanner) demoBanner.hidden = true;
    }

    if (Array.isArray(classes) && classFilter) {
      classFilter.innerHTML = '<option value="">All classes</option>';
      classes.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        classFilter.appendChild(opt);
      });
    }

    // Check if URL has ?id= to open Page 2 directly
    const urlParams = new URLSearchParams(window.location.search);
    const initialId = urlParams.get('id');
    if (initialId) {
      navigateToResult(initialId);
    }
  }

  // Suggestions
  function hideSuggestions() {
    if (!suggestionsBox) return;
    suggestionsBox.hidden = true;
    suggestionsBox.innerHTML = '';
    if (studentInput) {
      studentInput.setAttribute('aria-expanded', 'false');
      studentInput.removeAttribute('aria-activedescendant');
    }
    activeIndex = -1;
    currentSuggestions = [];
  }

  function renderSuggestions(items) {
    currentSuggestions = items;
    activeIndex = -1;
    if (!items || items.length === 0) {
      hideSuggestions();
      return;
    }

    suggestionsBox.innerHTML = items
      .map(
        (item, idx) => `
        <li
          id="sugg-${idx}"
          class="suggestion-item"
          role="option"
          aria-selected="false"
          data-id="${escapeHtml(item.id)}"
          data-name="${escapeHtml(item.name)}"
        >
          <svg class="suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          <span class="suggestion-name">${escapeHtml(item.name)}</span>
        </li>`
      )
      .join('');

    suggestionsBox.hidden = false;
    if (studentInput) studentInput.setAttribute('aria-expanded', 'true');
  }

  function highlightSuggestion(index) {
    const listItems = suggestionsBox.querySelectorAll('.suggestion-item');
    listItems.forEach((li, idx) => {
      const isActive = idx === index;
      li.classList.toggle('active', isActive);
      li.setAttribute('aria-selected', isActive ? 'true' : 'false');
      if (isActive && studentInput) {
        studentInput.setAttribute('aria-activedescendant', `sugg-${idx}`);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  async function fetchSuggestions(query) {
    const q = query.trim();
    if (q.length < 1) {
      hideSuggestions();
      return;
    }

    const cls = classFilter && classFilter.value ? encodeURIComponent(classFilter.value) : '';
    try {
      const url = `/api/suggest?q=${encodeURIComponent(q)}${cls ? `&class=${cls}` : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.suggestions)) {
          renderSuggestions(data.suggestions);
          return;
        }
      }
    } catch (err) {
      // offline fallback
    }

    if (Array.isArray(window.__FALLBACK_STUDENTS__)) {
      const normQ = normalizeText(q);
      const qTokens = normQ.split(' ');
      const filterCls = classFilter && classFilter.value ? normalizeText(classFilter.value) : '';

      const scored = [];
      for (const s of window.__FALLBACK_STUDENTS__) {
        if (filterCls && normalizeText(s.className) !== filterCls) continue;
        const normName = normalizeText(s.name);
        const tokens = normName.split(' ');
        if (normName.startsWith(normQ) || allTokensPrefix(qTokens, tokens)) {
          scored.push({ id: s.id, name: s.name });
          if (scored.length >= 8) break;
        }
      }
      renderSuggestions(scored);
    }
  }

  function selectSuggestion(item) {
    if (studentInput) studentInput.value = item.name;
    hideSuggestions();
    clearNotices();
    navigateToResult(item.id);
  }

  // Primary Lookup on Page 1
  async function performLookup() {
    const query = studentInput ? studentInput.value.trim() : '';
    if (query.length < 3) {
      showNotice(
        'Please enter a name',
        'Type at least 3 letters of your child\'s name to find their book.'
      );
      if (studentInput) studentInput.focus();
      return;
    }

    hideSuggestions();
    clearNotices();
    setLoading(true);

    const cls = classFilter && classFilter.value ? encodeURIComponent(classFilter.value) : '';
    try {
      const url = `/api/lookup?name=${encodeURIComponent(query)}${cls ? `&class=${cls}` : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        handleLookupResponse(data, query);
        return;
      }
    } catch (err) {
      // offline fallback
    }

    // Offline lookup
    if (Array.isArray(window.__FALLBACK_STUDENTS__)) {
      const normQ = normalizeText(query);
      const qTokens = normQ.split(' ');
      const filterCls = classFilter && classFilter.value ? normalizeText(classFilter.value) : '';
      const inClass = (s) => !filterCls || normalizeText(s.className) === filterCls;

      const exact = window.__FALLBACK_STUDENTS__.filter((s) => {
        const sNorm = normalizeText(s.name);
        const sRev = sNorm.split(' ').reverse().join(' ');
        return (sNorm === normQ || sRev === normQ) && inClass(s);
      });

      if (exact.length === 1) {
        navigateToResult(exact[0].id);
        setLoading(false);
        return;
      } else if (exact.length > 1) {
        showAmbiguous(exact);
        setLoading(false);
        return;
      }

      const prefix = window.__FALLBACK_STUDENTS__.filter((s) => {
        const sTokens = normalizeText(s.name).split(' ');
        return inClass(s) && allTokensPrefix(qTokens, sTokens);
      });

      if (prefix.length === 1) {
        navigateToResult(prefix[0].id);
        setLoading(false);
        return;
      } else if (prefix.length > 1) {
        showAmbiguous(prefix);
        setLoading(false);
        return;
      }

      if (filterCls) {
        const elsewhere = window.__FALLBACK_STUDENTS__.filter((s) => {
          const sTokens = normalizeText(s.name).split(' ');
          return allTokensPrefix(qTokens, sTokens);
        });
        if (elsewhere.length > 0) {
          showNotFoundInClass(
            `Student found in ${elsewhere.map((s) => s.className).join(', ')}, but not in the selected class.`,
            elsewhere
          );
          setLoading(false);
          return;
        }
      }

      showNotFound(query);
      setLoading(false);
      return;
    }

    showNotice('Search Error', 'Unable to look up student right now. Please try again.');
    setLoading(false);
  }

  function handleLookupResponse(data, query) {
    setLoading(false);
    switch (data.status) {
      case 'found':
        navigateToResult(data.student.id);
        break;

      case 'ambiguous':
        showAmbiguous(data.candidates);
        break;

      case 'not_found_in_class':
        showNotFoundInClass(data.message, data.otherMatches);
        break;

      case 'not_found':
        showNotFound(query);
        break;

      case 'invalid_input':
      default:
        showNotice('Please refine your search', data.message || 'Please type at least 3 letters.');
        break;
    }
  }

  // Notice Renderers on Page 1 (only for errors, ambiguity, or hints)
  function clearNotices() {
    if (noticeArea) noticeArea.innerHTML = '';
  }

  function showNotice(title, desc) {
    if (!noticeArea) return;
    noticeArea.innerHTML = `
      <div class="notice-card" role="region" aria-label="${escapeHtml(title)}">
        <div class="notice-icon" aria-hidden="true">ℹ️</div>
        <h3 class="notice-title">${escapeHtml(title)}</h3>
        <p class="notice-text">${escapeHtml(desc)}</p>
      </div>
    `;
    noticeArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showNotFound(name) {
    if (!noticeArea) return;
    noticeArea.innerHTML = `
      <div class="notice-card" role="region" aria-label="Student Not Found">
        <div class="notice-icon" aria-hidden="true">🔍</div>
        <h3 class="notice-title">Student Not Found</h3>
        <p class="notice-text">
          We could not find <strong>"${escapeHtml(name)}"</strong> in the database.<br />
          Please double-check the spelling, or contact the school office at
          <a href="mailto:abdelali.elfedyl1@gmail.com">abdelali.elfedyl1@gmail.com</a>.
        </p>
      </div>
    `;
    noticeArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showNotFoundInClass(message, otherMatches) {
    if (!noticeArea) return;
    let othersHtml = '';
    if (Array.isArray(otherMatches) && otherMatches.length > 0) {
      othersHtml = `
        <div style="margin: 12px 0 10px 0; text-align: left;">
          <p style="font-size: 0.88rem; font-weight: 600; color: #475569; margin-bottom: 8px;">
            Found in another class:
          </p>
          <ul class="ambiguous-list">
            ${otherMatches
              .map(
                (m) => `
              <li>
                <button type="button" class="ambiguous-option-btn" data-id="${escapeHtml(m.id)}">
                  <span class="ambiguous-name">${escapeHtml(m.name)}</span>
                  <span class="ambiguous-class-badge">${escapeHtml(m.className)}</span>
                </button>
              </li>`
              )
              .join('')}
          </ul>
        </div>
      `;
    }

    noticeArea.innerHTML = `
      <div class="notice-card" role="region" aria-label="Class Mismatch">
        <div class="notice-icon" aria-hidden="true">⚠️</div>
        <h3 class="notice-title">Class Mismatch</h3>
        <p class="notice-text">${escapeHtml(message)}</p>
        ${othersHtml}
      </div>
    `;

    noticeArea.querySelectorAll('.ambiguous-option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (id) navigateToResult(id);
      });
    });

    noticeArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showAmbiguous(candidates) {
    if (!noticeArea) return;
    const listHtml = (candidates || [])
      .map(
        (c) => `
        <li>
          <button type="button" class="ambiguous-option-btn" data-id="${escapeHtml(c.id)}">
            <span class="ambiguous-name">${escapeHtml(c.name)}</span>
            <span class="ambiguous-class-badge">${escapeHtml(c.className)}</span>
          </button>
        </li>`
      )
      .join('');

    noticeArea.innerHTML = `
      <div class="ambiguous-card" role="region" aria-label="Multiple Students Found">
        <div class="ambiguous-title">
          <span aria-hidden="true">⚠️</span>
          <span>Multiple Students Found</span>
        </div>
        <p class="ambiguous-desc">
          Please select your child's class below to view their book:
        </p>
        <ul class="ambiguous-list">
          ${listHtml}
        </ul>
      </div>
    `;

    noticeArea.querySelectorAll('.ambiguous-option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (id) navigateToResult(id);
      });
    });

    noticeArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setLoading(loading) {
    isFetching = loading;
    if (findBtn) {
      findBtn.disabled = loading;
      findBtn.innerHTML = loading
        ? '<span class="spinner" aria-hidden="true"></span>'
        : '<svg class="btn-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg><span>FIND MY BOOK &rarr;</span>';
    }
  }

  // Listeners
  if (studentInput) {
    studentInput.addEventListener('input', (e) => {
      clearNotices();
      const val = e.target.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchSuggestions(val);
      }, 180);
    });

    studentInput.addEventListener('keydown', (e) => {
      if (suggestionsBox && (suggestionsBox.hidden || currentSuggestions.length === 0)) {
        if (e.key === 'Enter') {
          e.preventDefault();
          performLookup();
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % currentSuggestions.length;
        highlightSuggestion(activeIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        highlightSuggestion(activeIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < currentSuggestions.length) {
          selectSuggestion(currentSuggestions[activeIndex]);
        } else {
          performLookup();
        }
      } else if (e.key === 'Escape') {
        hideSuggestions();
      }
    });
  }

  if (suggestionsBox) {
    suggestionsBox.addEventListener('click', (e) => {
      const itemEl = e.target.closest('.suggestion-item');
      if (!itemEl) return;
      const id = itemEl.getAttribute('data-id');
      const name = itemEl.getAttribute('data-name');
      if (id && name) {
        selectSuggestion({ id, name });
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (studentInput && suggestionsBox && !studentInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
      hideSuggestions();
    }
  });

  if (classFilter) {
    classFilter.addEventListener('change', () => {
      clearNotices();
      if (studentInput && studentInput.value.trim().length >= 3) {
        performLookup();
      }
    });
  }

  if (findBtn) {
    findBtn.addEventListener('click', () => {
      performLookup();
    });
  }

  // Page 2 back buttons
  if (btnBackSearch) {
    btnBackSearch.addEventListener('click', (e) => {
      e.preventDefault();
      backToSearch();
    });
  }
  if (btnSearchAgainP2) {
    btnSearchAgainP2.addEventListener('click', (e) => {
      e.preventDefault();
      backToSearch();
    });
  }

  init();
})();
