// Made-up data in the shape the parser expects (taken from the code that used to read it).
// None of it comes from LinkedIn.
import { TYPES } from '../../src/main/linkedin/projects.js';

export function project({
  id = '1001',
  jobType = 'Resume Writing',
  client = 'Jane Q Doe',
  subtitle = 'Engineering Manager at Example Corp',
  navigationUrl = 'https://www.linkedin.com/in/jane-doe',
  insight = '5m ago',
  locationUrn = 'urn:li:fsd_geo:1',
  questions = [],
  omit = [],
} = {}) {
  const sections = [
    {
      header: {
        $type: TYPES.header,
        title: { text: jobType },
        insight: insight === null ? undefined : { text: insight },
        '*locationResolutionResult': locationUrn,
      },
    },
    {
      creatorInformation: {
        $type: TYPES.creator,
        serviceRequesterEntityLockup: {
          title: { text: client },
          subtitle: { text: subtitle },
          navigationUrl,
        },
      },
    },
    { description: { $type: TYPES.description, questionnaireQuestions: questions } },
  ].filter((section) => !omit.includes(Object.keys(section)[0]));
  return {
    $type: TYPES.project,
    entityUrn: `urn:li:fsd_marketplaceProject:(${id},67890)`,
    detailViewSectionsResolutionResults: sections,
  };
}

export const location = (urn = 'urn:li:fsd_geo:1', name = 'Austin, Texas') => ({
  $type: 'com.linkedin.voyager.dash.common.Geo',
  entityUrn: urn,
  defaultLocalizedNameWithoutCountryName: name,
});

export const career = (answer) => ({
  question: 'Where are you in your career?',
  answer: { textualAnswer: answer },
});

export const response = (...projects) => ({ included: [location(), ...projects] });
