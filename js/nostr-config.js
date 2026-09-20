/* Shared NOSTR settings for the chat and the forum.
 * The relay list is also in tools/nostr-admin.mjs and both must be changed together.
 * These relays were picked because they accept events from keys they have never
 * seen; many popular relays do not, which would silence anyone who signs up here.
 */
window.SemRedeConfig = {
  RELAYS: [
    'wss://relay.primal.net',
    'wss://relay.damus.io',
    'wss://relay.snort.social',
    'wss://nostr-pub.wellorder.net',
    'wss://purplerelay.com',
    'wss://relay.piazza.today'
  ],

  // Admin identity: its NIP-51 mute list (kind 10000) hides accounts on this site.
  ADMIN_PUBKEY: 'a98d7aeb75d99c10a945cd1fe308446434344c0ef9b3589d74f87acd1550f4c3',

  // NIP-28 channel used by /chat
  CHANNEL_ID: 'e80c52b1d568d735530c5461d2386d2a28fcaa619f183101af66c973697ad7eb',

  // Forum: NIP-7D threads (kind 11) tagged with FORUM_TAG and one category tag,
  // answered by NIP-22 comments (kind 1111). Nothing is created in advance, so
  // the same categories carry over from one year to the next.
  // Registration: NIP-52 date-based calendar events (kind 31922) published by
  // the admin key with tools/nostr-admin.mjs calendar. People answer with
  // RSVPs (kind 31925), which is also what the counters read.
  EVENTS: [
    {
      slug: 'eva',
      name: 'The week at Eva Farm',
      dates: 'Monday to Friday, October 26 to 30',
      about: 'Five days of hands-on sessions, talks, meals and community time.',
      coord: '31922:a98d7aeb75d99c10a945cd1fe308446434344c0ef9b3589d74f87acd1550f4c3:semrede-2026-eva',
      id: '2c01a19321604cc326770d2ea8a76d956631adafef4f3da58937fc03bc9bb276'
    },
    {
      slug: 'embaixada',
      name: 'Open day at Edif\u00edcio Embaixada',
      dates: 'Saturday, October 31',
      about: 'Talks, demos, community fair and the closing celebration, in the centre of Coimbra.',
      coord: '31922:a98d7aeb75d99c10a945cd1fe308446434344c0ef9b3589d74f87acd1550f4c3:semrede-2026-embaixada',
      id: '9efc9a1ecf299c5dc9647d071650c920486635c39a25f7c30021bb8b8cbb6c92'
    }
  ],

  // Visit statistics. A beacon is a kind 30078 event signed by a throwaway key,
  // p-tagged to this key, with its content encrypted to it (NIP-44). Nobody
  // else can read it, and two beacons cannot be tied to each other.
  // The secret key lives at ~/.config/semrede/nostr-stats.nsec and is never in
  // this repository; tools/stats.mjs is the only thing that can read beacons.
  STATS: {
    ENABLED: true,
    PUBKEY: '196e42c6b67732a935e4c4f88dd0bce628d07dfbe0a616e5dbeba8e9f7a7be6b',
    // Two relays, not all six: fewer people see a visitor's address, and the
    // beacons stay out of the way of the chat and the forum.
    RELAYS: ['wss://nostr-pub.wellorder.net', 'wss://relay.primal.net'],
    SAMPLE: 1
  },

  FORUM_TAG: 'semrede',
  CATEGORIES: [
    { slug: 'news', name: 'News', about: 'Announcements about SemRede itself.', color: 'orange' },
    { slug: 'showcase', name: 'Showcase', about: 'Propose a project for the event and ask for a stand.', color: 'orange' },
    { slug: 'tech', name: 'Tech', about: 'Hardware, software, repairs, things you built.', color: 'teal' },
    { slug: 'mesh', name: 'Mesh & radio', about: 'Mesh networks, LoRa, HF, antennas, frequencies.', color: 'yellow' },
    { slug: 'energy', name: 'Energy & water', about: 'Solar, batteries, wells, filters, heating.', color: 'green' },
    { slug: 'food', name: 'Food & growing', about: 'Gardens, seeds, animals, storing and cooking.', color: 'green' },
    { slug: 'crypto', name: 'Crypto', about: 'Bitcoin, lightning, nostr, keys and privacy.', color: 'yellow' },
    { slug: 'community', name: 'Community', about: 'Living together, projects, land, money, conflicts.', color: 'orange' },
    { slug: 'rides', name: 'Rides & logistics', about: 'Getting to Coimbra, sharing cars, sleeping places.', color: 'teal' },
    { slug: 'market', name: 'Market', about: 'Sell, swap, lend, give away, look for.', color: 'orange' },
    { slug: 'music', name: 'Music', about: 'Artists, instruments, recordings, jam sessions.', color: 'green' },
    { slug: 'other', name: 'Other', about: 'Everything that fits nowhere else.', color: 'teal' }
  ]
};
