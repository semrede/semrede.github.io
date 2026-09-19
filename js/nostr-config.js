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
  FORUM_TAG: 'semrede',
  CATEGORIES: [
    { slug: 'news', name: 'News', about: 'Announcements about SemRede itself.', color: 'orange' },
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
