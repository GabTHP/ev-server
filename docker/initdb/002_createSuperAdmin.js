db = db.getSiblingDB('evse');
db.getCollection('5c866e81a2d9593de43efdb4".users').insert({
  _id: ObjectId(),
  email: 'gb@ip.eu',
  address: {
    address1: null,
    address2: null,
    postalCode: null,
    city: null,
    department: null,
    region: null,
    country: null,
    coordinates: [
      0,
      0
    ]
  },
  costCenter: null,
  createdBy: null,
  createdOn: ISODate('2020-04-02T00:00:00.000+0000'),
  deleted: false,
  firstName: 'Super',
  iNumber: null,
  issuer: true,
  lastChangedBy: null,
  locale: 'en_US',
  mobile: null,
  name: 'ADMIN',
  notifications: {
    sendSessionStarted: true,
    sendOptimalChargeReached: true,
    sendEndOfCharge: true,
    sendEndOfSession: true,
    sendUserAccountStatusChanged: true,
    sendSessionNotStarted: true,
    sendCarSynchronizationFailed: true,
    sendUserAccountInactivity: true,
    sendPreparingSessionNotStarted: false,
    sendBillingSynchronizationFailed: false,
    sendNewRegisteredUser: false,
    sendUnknownUserBadged: false,
    sendChargingStationStatusError: false,
    sendChargingStationRegistered: false,
    sendOcpiPatchStatusError: false,
    sendOicpPatchStatusError: false,
    sendOfflineChargingStations: false
  },
  phone: null,
  password: '$2a$10$cXrk5/NWhu9cP.bSZmq3E.VoiROZV8cwuCg5Qjjowx6UUN1u3U3B6',
  passwordBlockedUntil: null,
  passwordResetHash: null,
  passwordWrongNbrTrials: NumberInt(0),
  eulaAcceptedHash: 'c308ac57857ce483ef1bb50fe8c1bc2bc3b5fcf067114c8b4a3a7abf9896c45f',
  eulaAcceptedOn: ISODate('2020-04-02T00:00:00.000+0000'),
  eulaAcceptedVersion: 28,
  role: 'S',
  status: 'A',
  notificationsActive: true
});
