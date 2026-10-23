/** LinkedIn web API answers, trimmed to the fields the parsers read. Both response shapes appear. */

export const SELF_URN = 'urn:li:fs_miniProfile:ACoSELF';

const mini = (id: string, publicId: string, first: string, last: string, occupation = '') => ({
  $type: 'com.linkedin.voyager.identity.shared.MiniProfile',
  entityUrn: `urn:li:fs_miniProfile:${id}`,
  publicIdentifier: publicId,
  firstName: first,
  lastName: last,
  occupation,
});

export const people = {
  self: mini('ACoSELF', 'me-self', 'Sam', 'Self', 'Founder'),
  jane: mini('ACoJANE', 'jane-doe', 'Jane', 'Doe', 'Head of Sales at Acme'),
  bob: mini('ACoBOB', 'bob-lee', 'Bob', 'Lee', 'CTO'),
  carl: mini('ACoCARL', 'carl-x', 'Carl', 'Xu', 'Engineer'),
  dana: mini('ACoDANA', 'dana-k', 'Dana', 'Kim', 'Designer'),
};

/** /me, normalized shape. */
export const me = {
  data: { '*miniProfile': people.self.entityUrn, plainId: 1234 },
  included: [people.self],
};

/** /identity/profiles/{id}/profileView, plain shape. */
export function profileView(p: (typeof people)[keyof typeof people]) {
  return {
    profile: {
      entityUrn: p.entityUrn.replace('fs_miniProfile', 'fs_profile'),
      firstName: p.firstName,
      lastName: p.lastName,
      headline: p.occupation,
      geoLocationName: 'Amsterdam, North Holland',
      summary: `About ${p.firstName}.`,
      miniProfile: p,
    },
    positionView: {
      elements: [
        { title: 'Head of Sales', companyName: 'Acme', locationName: 'Amsterdam', timePeriod: { startDate: { year: 2021, month: 3 } }, description: 'Sales.' },
        { title: 'Account Executive', companyName: 'Initech', timePeriod: { startDate: { year: 2017 }, endDate: { year: 2021, month: 2 } } },
      ],
    },
    educationView: { elements: [{ schoolName: 'University of Amsterdam', degreeName: 'MSc', fieldOfStudy: 'Economics', timePeriod: { startDate: { year: 2012 }, endDate: { year: 2016 } } }] },
  };
}

/** /identity/profiles/{id}/networkinfo, normalized shape. */
export const networkinfo = (distance: string) => ({ data: { distance: { value: distance }, followersCount: 10 }, included: [] });

/** /graphql people search, normalized shape. */
export const search = {
  data: { data: { searchDashClustersByAll: { '*elements': ['urn:li:cluster:1'] } } },
  included: [
    {
      $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
      entityUrn: 'urn:li:fsd_entityResultViewModel:1',
      navigationUrl: 'https://www.linkedin.com/in/jane-doe?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoJANE',
      title: { text: 'Jane Doe' },
      primarySubtitle: { text: 'Head of Sales at Acme' },
      secondarySubtitle: { text: 'Amsterdam' },
    },
    {
      $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
      entityUrn: 'urn:li:fsd_entityResultViewModel:2',
      navigationUrl: 'https://www.linkedin.com/search/results/people/headless',
      title: { text: 'LinkedIn Member' },
    },
    {
      $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
      entityUrn: 'urn:li:fsd_entityResultViewModel:3',
      navigationUrl: 'https://www.linkedin.com/in/bob-lee',
      title: { text: 'Bob Lee' },
      primarySubtitle: { text: 'CTO' },
    },
  ],
};

/** The same search, plain nested shape. */
export const searchPlain = {
  data: {
    searchDashClustersByAll: {
      _type: 'com.linkedin.restli.common.CollectionResponse',
      elements: [
        {
          _type: 'com.linkedin.voyager.dash.search.SearchClusterViewModel',
          items: [{ item: { entityResult: { navigationUrl: 'https://www.linkedin.com/in/carl-x', title: { text: 'Carl Xu' }, secondarySubtitle: { text: 'Berlin' } } } }],
        },
      ],
    },
  },
};

const member = (p: { entityUrn: string; publicIdentifier: string; firstName: string; lastName: string }) => ({
  'com.linkedin.voyager.messaging.MessagingMember': { miniProfile: p },
});

export function event(thread: string, id: string, from: (typeof people)[keyof typeof people], text: string, createdAt: number) {
  return {
    entityUrn: `urn:li:fs_event:(${thread},${id})`,
    createdAt,
    subtype: 'MEMBER_TO_MEMBER',
    from: member(from),
    eventContent: { 'com.linkedin.voyager.messaging.event.MessageEvent': { attributedBody: { text } } },
  };
}

export function conversation(
  thread: string,
  other: (typeof people)[keyof typeof people],
  opts: { unread?: number; lastActivityAt: number; events?: ReturnType<typeof event>[]; group?: boolean; name?: string },
) {
  return {
    entityUrn: `urn:li:fs_conversation:${thread}`,
    groupChat: opts.group ?? false,
    name: opts.name,
    unreadCount: opts.unread ?? 0,
    read: (opts.unread ?? 0) === 0,
    lastActivityAt: opts.lastActivityAt,
    participants: [member(other)],
    events: opts.events ?? [],
  };
}

/** /relationships/invitationViews, normalized shape. */
export const invitationViews = {
  data: { '*elements': ['urn:li:fs_relInvitationView:1'] },
  included: [
    { $type: 'com.linkedin.voyager.relationships.invitation.InvitationView', entityUrn: 'urn:li:fs_relInvitationView:1', '*invitation': 'urn:li:fs_relInvitation:7001' },
    {
      $type: 'com.linkedin.voyager.relationships.invitation.Invitation',
      entityUrn: 'urn:li:fs_relInvitation:7001',
      sharedSecret: 'secret-7001',
      sentTime: Date.UTC(2026, 2, 9, 12, 0, 0),
      message: 'Hi Sam, met you at the meetup.',
      '*fromMember': people.carl.entityUrn,
    },
    people.carl,
  ],
};

/** verifyQuotaAndCreateV2 answer. */
export const inviteCreated = {
  data: { value: { '*invitationUrn': 'urn:li:fsd_invitation:9001' } },
  included: [{ entityUrn: 'urn:li:fsd_invitation:9001', invitationId: 9001 }],
};

export const inviteCantResend = { data: { code: 'CANT_RESEND_YET', status: 400 } };

/** Send-in-thread answer. */
export const sendEvent = (thread: string, id: string, createdAt: number) => ({
  data: { value: { eventUrn: `urn:li:fs_event:(${thread},${id})`, createdAt } },
  included: [],
});

/** New-thread answer. */
export const createConversation = (thread: string, id: string, createdAt: number) => ({
  value: { conversationUrn: `urn:li:fs_conversation:${thread}`, eventUrn: `urn:li:fs_event:(${thread},${id})`, createdAt },
});
