/**
 * Reads the ProFinder project requests out of LinkedIn's "voyager" JSON, which is what the page itself
 * receives. The structure below is the one the old code relied on; it is not a documented API and can
 * change without notice, so every lookup is defensive: a request that does not have the expected parts
 * is skipped (and counted) instead of throwing and losing the whole batch.
 */

const BASE = 'com.linkedin.voyager.dash.marketplaces';
export const TYPES = {
  project: `${BASE}.projects.MarketplaceProject`,
  header: `${BASE}.projectdetailsview.MarketplaceProjectDetailsViewSectionsHeader`,
  creator: `${BASE}.projectdetailsview.MarketplaceProjectDetailsViewSectionsCreator`,
  description: `${BASE}.projectdetailsview.MarketplaceProjectDetailsViewSectionsDescription`,
};

export const CAREER_QUESTION = 'Where are you in your career?';
const SENIOR_CAREER = /Late career|Mid career/i;

const MINUTE = 60 * 1000;
const UNITS = [
  [/^(m|min|mins|minute|minutes)$/, (d, n) => d.setTime(d.getTime() - n * MINUTE)],
  [/^(h|hr|hrs|hour|hours)$/, (d, n) => d.setHours(d.getHours() - n)],
  [/^(d|day|days)$/, (d, n) => d.setDate(d.getDate() - n)],
  [/^(w|wk|wks|week|weeks)$/, (d, n) => d.setDate(d.getDate() - n * 7)],
  [/^(mo|month|months)$/, (d, n) => d.setMonth(d.getMonth() - n)],
  [/^(y|yr|yrs|year|years)$/, (d, n) => d.setFullYear(d.getFullYear() - n)],
];

/**
 * "5m ago", "2 hours ago", "3w ago", "less than one minute ago" -> a Date, or null if it cannot be read.
 * A capital "M" is a month and a lower-case "m" a minute, as in LinkedIn's short forms.
 */
export function parseRelativeTime(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  if (text.includes('less than one minute ago')) return new Date(now);
  const match = /(\d+)\s*([A-Za-z]+)\s+ago/.exec(text);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] === 'M' ? 'mo' : match[2].toLowerCase();
  const found = UNITS.find(([pattern]) => pattern.test(unit));
  if (!found) return null;
  const date = new Date(now);
  found[1](date, amount);
  return date;
}

const pad = (n) => String(n).padStart(2, '0');
/** Local date as YYYY-MM-DD. (The old code printed the month 0-based: November came out as "10".) */
export const formatDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const formatTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function sectionOf(project, key, type) {
  const sections = project?.detailViewSectionsResolutionResults;
  if (!Array.isArray(sections)) return null;
  return sections.find((section) => section?.[key]?.$type === type)?.[key] ?? null;
}

/** "12345" out of urn:li:...:(12345,67890) */
export function projectId(urn) {
  const match = /\((\d+),/.exec(String(urn ?? '')) ?? /(\d+)/.exec(String(urn ?? ''));
  return match ? match[1] : null;
}

export function splitName(fullName) {
  const name = String(fullName ?? '').trim();
  const space = name.indexOf(' ');
  // The old code sliced to indexOf(' ') even when there was no space, which cut the last letter off.
  return space === -1
    ? { first: name, last: '' }
    : { first: name.slice(0, space), last: name.slice(space + 1).trim() };
}

/** Everything the app needs from one request, or null when the request lacks its header or creator. */
export function describeProject(project, included, now = new Date()) {
  const header = sectionOf(project, 'header', TYPES.header);
  const creator = sectionOf(project, 'creatorInformation', TYPES.creator);
  const description = sectionOf(project, 'description', TYPES.description);
  const lockup = creator?.serviceRequesterEntityLockup;
  const id = projectId(project?.entityUrn);
  const jobType = header?.title?.text;
  const clientName = lockup?.title?.text;
  if (!header || !creator || !id || !jobType || !clientName) return null;

  const locationUrn = header['*locationResolutionResult'];
  const location =
    included.find((item) => item?.entityUrn === locationUrn)
      ?.defaultLocalizedNameWithoutCountryName ?? '';
  const created = parseRelativeTime(header.insight?.text, now) ?? now;
  const { first, last } = splitName(clientName);
  const questions = description?.questionnaireQuestions ?? [];
  const careerQuestion = questions.find((q) => q?.question === CAREER_QUESTION);

  return {
    id,
    urn: project.entityUrn,
    url: `https://www.linkedin.com/service-marketplace/projects/${id}`,
    jobType,
    clientName,
    careerAnswer: careerQuestion ? (careerQuestion.answer?.textualAnswer ?? '') : null,
    // Column names are the headers of the Google Sheet, so they stay exactly as they were.
    row: {
      Title: lockup.subtitle?.text ?? '',
      'Job Type': jobType,
      'Proposal URL': `https://www.linkedin.com/service-marketplace/projects/${id}`,
      'Proposal Date': formatDate(created),
      'Proposal Time': formatTime(created),
      'Client First Name': first,
      'Client Last Name': last,
      'Client Location': location,
      'Client Profile': lockup.navigationUrl ?? '',
      'First Followup': '',
    },
  };
}

/** All readable requests in a response, and how many could not be read. */
export function describeAll(data, now = new Date()) {
  const included = Array.isArray(data?.included) ? data.included : [];
  const projects = included.filter((item) => item?.$type === TYPES.project);
  const described = [];
  let skipped = 0;
  for (const project of projects) {
    const item = describeProject(project, included, now);
    if (item) described.push(item);
    else skipped += 1;
  }
  return { projects: described, skipped };
}

/**
 * Whether to decline instead of answering: the request asks where the client is in their career and the
 * answer is neither late nor mid career.
 */
export function shouldDecline(described) {
  return described.careerAnswer !== null && !SENIOR_CAREER.test(described.careerAnswer);
}
