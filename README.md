# School Transportation App

A single Expo app that serves students, parents, and drivers. Rather than shipping three separate apps, users log in and choose their role — student, parent, or driver — and are routed to the section that matches. The admin portal lives behind an additional layer of authentication.

## Architecture

One app, four sections:

| Section | Access |
| --- | --- |
| Student | Role selected at login |
| Parent | Role selected at login |
| Driver | Role selected at login |
| Admin portal | Password / elevated auth required |

## Features

### Student

- Live van location
- ETA to pickup stop
- Alerts when the van is 15 and 5 minutes away
- QR code check-in / check-out
- View driver, van, and route details
- Mark absent or on vacation
- View transportation status (Waiting, On Board, Dropped Off)

### Parent

- Live bus tracking
- Know whether the child is on the van or dropped off
- Boarding and drop-off notifications
- Delay and emergency alerts
- Monthly payments and payment history
- Report an absence or request a temporary pickup change
- Submit suggestions or support requests

### Driver

- View assigned route and next stop
- Student list for each stop
- See absentees and skip those stops
- Scan student QR codes on boarding and exit
- View students currently onboard
- GPS navigation and route updates
- Report delays or emergencies

### Admin Portal

- Add / edit / delete students, parents, drivers, and vehicles
- Create routes and assign students
- Live tracking of all vehicles
- Attendance and boarding reports
- Payment management and reminders
- Send announcements and notifications
- View route performance and operational reports

## Getting started

Requires a Mac with Xcode installed (open it once so the command line tools finish installing) and Node.

```sh
git clone git@github.com:abhigyankumarpathak/bus-location-tracker.git
cd bus-location-tracker
npm install
npx expo run:ios
```

`expo run:ios` compiles the native iOS project, installs it on the simulator, and starts the Metro bundler. Run it the first time, and any time a native dependency or native config changes.

Day to day, once the app is installed:

```sh
npx expo start
```

That starts Metro only. Press `i` to open the existing build on the simulator.

## Native folders are generated

`ios/` and `android/` are gitignored — they are generated from `app.json` by Expo prebuild and should never be committed. Native configuration goes in `app.json`, otherwise it gets overwritten on the next prebuild.
