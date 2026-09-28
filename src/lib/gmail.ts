// Gmail via Google Identity Services token flow (read-only). The token stays in the
// browser; only a small inbox snapshot (sender, subject, snippet) goes to the server.
export type InboxItem = { from: string; subject: string; snippet: string; date: string; unread: boolean };
export type GmailResult = { email: string; inbox: InboxItem[]; simulated: boolean };

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

let gisLoaded: Promise<void> | null = null;
function loadGis() {
  gisLoaded ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => res();
    s.onerror = () => { gisLoaded = null; rej(new Error('gis_load_failed')); };
    document.head.appendChild(s);
  });
  return gisLoaded;
}

/** Preload so the popup can open synchronously inside the click handler. */
export function preloadGmail(clientId: string | null) { if (clientId) loadGis().catch(() => {}); }

export function connectGmail(clientId: string): Promise<GmailResult> {
  return new Promise((resolve, reject) => {
    const g = (window as any).google?.accounts?.oauth2;
    if (!g) { reject(new Error('gis_not_ready')); return; }
    const client = g.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt: '',
      callback: async (resp: any) => {
        if (resp.error) return reject(new Error(resp.error));
        if (!g.hasGrantedAllScopes(resp, SCOPE)) return reject(new Error('scope_denied'));
        try { resolve(await fetchInbox(resp.access_token)); } catch (e) { reject(e); }
      },
      error_callback: (err: any) => reject(new Error(err?.type || 'popup_failed')),
    });
    client.requestAccessToken(); // must run synchronously in the click
  });
}

// A non-2xx from Google must never look like a successful (empty) connection.
// 403 usually means the Gmail API isn't enabled or the account isn't a test user.
async function gget(url: string, H: Record<string, string>) {
  let r: Response;
  try { r = await fetch(url, { headers: H }); } catch { throw new Error('gmail_network'); }
  if (r.status === 401) throw new Error('gmail_unauthorized');
  if (r.status === 403) throw new Error('gmail_forbidden');
  if (r.status === 429) throw new Error('gmail_rate_limited');
  if (!r.ok) throw new Error(`gmail_http_${r.status}`);
  return r.json();
}

async function fetchInbox(token: string): Promise<GmailResult> {
  const H = { Authorization: `Bearer ${token}` };
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const profile = await gget(`${base}/profile`, H);
  const list = await gget(`${base}/messages?maxResults=8&labelIds=INBOX`, H);
  const ids: string[] = (list.messages || []).map((m: any) => m.id);
  const msgs = await Promise.all(
    ids.map((id) =>
      gget(`${base}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, H)
        .catch(() => null) // one unreadable message shouldn't fail the whole snapshot
    )
  );
  const inbox = msgs.filter(Boolean).map((m: any) => {
    const h = (n: string) => m.payload?.headers?.find((x: any) => x.name === n)?.value || '';
    return { from: h('From'), subject: h('Subject'), snippet: decode(m.snippet || ''), date: h('Date'), unread: (m.labelIds || []).includes('UNREAD') };
  });
  return { email: profile.emailAddress || '', inbox, simulated: false };
}

function decode(s: string) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

/** Clearly-labelled demo data for when no Google client is configured. */
export function simulatedGmail(): GmailResult {
  const now = new Date();
  const d = (h: number) => new Date(now.getTime() - h * 3600e3).toUTCString();
  return {
    email: 'demo@sample.inbox',
    simulated: true,
    inbox: [
      { from: 'Dana Whitfield <dana@northwind.co>', subject: 'Can we move Thursday’s sync?', snippet: 'Something came up. Does Friday 10am work for you instead? Want to lock the agenda before the board prep.', date: d(1), unread: true },
      { from: 'Chase <no-reply@chase.com>', subject: 'Your statement is ready', snippet: 'Your credit card statement for September is now available. Payment due Oct 14.', date: d(5), unread: true },
      { from: 'Marcus Lee <marcus@studio.io>', subject: 'Re: proposal draft', snippet: 'Looks great overall. Two small notes on pricing. Can you send v2 by Monday?', date: d(20), unread: false },
      { from: 'United Airlines <united@news.united.com>', subject: 'Check in for your flight to Austin', snippet: 'Your flight UA 1432 departs Tuesday at 7:05am. Check in now to save time.', date: d(26), unread: true },
      { from: 'Substack <digest@substack.com>', subject: 'Your weekly digest', snippet: '12 new posts from writers you follow.', date: d(40), unread: false },
    ],
  };
}
