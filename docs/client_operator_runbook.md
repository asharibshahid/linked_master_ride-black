# ACE Taxi Dispatch Dashboard - Operator Runbook

## What This System Does

The dashboard brings WhatsApp taxi jobs and OTS jobs into one dispatch workflow. It helps the operator review rides, approve suitable jobs, assign drivers and vehicles, track bids, monitor calendars, and find linked return ride opportunities.

## Daily Workflow

1. Open the dashboard:
   `http://localhost:3000/dashboard`

2. Check system readiness cards:
   - WhatsApp should show ready.
   - OTS rows/pipeline should show ready if OTS import is enabled.
   - Calendar should show ready if calendar events are expected.
   - Area Filter shows which area codes are being accepted.

3. Watch incoming jobs:
   - WhatsApp jobs land from WhatsApp groups.
   - OTS jobs land from the OTS import flow.
   - Valid jobs move toward Final Bid.
   - Incomplete jobs appear in Needs Review.

4. Fix Needs Review:
   - Edit pickup, drop-off, date, time, fare, or vehicle directly in the Needs Review table.
   - Click Save.
   - When the row is complete, click Move Final Bid.

5. Approve or reject Final Bid jobs:
   - Use Approve when the ride should be accepted for dispatch.
   - Use Reject when the ride should not be handled.
   - Closed rides cannot be reopened from the dashboard.

6. Generate and approve AI driver recommendations:
   - Click Generate AI Now if you want an immediate recommendation run.
   - Review the driver, vehicle, score, and reason.
   - Click Approve on a recommendation to assign it.
   - The system updates Final Bid with the assigned driver.

7. Check schedules:
   - Driver Schedule shows driver ride timeline.
   - Vehicle Schedule shows vehicle booking timeline.
   - When a ride is finished, click Complete.
   - Complete marks the schedule rows completed, sets the driver and vehicle available, and moves driver location to the ride drop-off.

8. Manage bids:
   - Use Bid to create a Bid Tracker entry from a Final Bid ride.
   - In Bid Control, edit bid amount or reason.
   - Use Approve, Reject, Done, or Failed.
   - Run Auto Bid only when the system is configured for the intended mode.

9. Check Calendar:
   - Calendar status appears on Final Bid and Approved Jobs.
   - If Calendar failed and Calendar is ready, click Retry Calendar.

10. Review linked and pre-book jobs:
   - Pre-book Jobs shows future work.
   - Linked Rides shows return ride opportunities where the same driver/vehicle may reduce empty driving.

## Dashboard Sections

- Action Required: Jobs needing operator attention first.
- Final Bid Jobs: Jobs waiting for approval, assignment, bid, or calendar action.
- Approved Jobs: Accepted jobs ready for assignment/calendar/bid follow-up.
- Pre-book Jobs: Future jobs sorted by pickup date and time.
- Upcoming Jobs: High-value upcoming rides.
- Needs Review: Incomplete or unclear rides that need correction.
- Driver Recommendations: AI recommendations with driver, vehicle, score, and reason.
- Linked Rides: Possible chained or return rides.
- Driver Timeline: Driver schedule and availability history.
- Vehicle Bookings: Vehicle schedule and booking conflicts.
- Bid Control: Bid review and OTS/manual bid status.
- Fleet Snapshot: Drivers and vehicles, with add/status controls.
- Dispatch Criteria: Area filter and auto-bid settings.
- Audit Log: Operator/system action history.

## Status Meaning

- Pending: Waiting for operator or system action.
- Approved: Accepted by operator.
- Rejected: Declined by operator.
- Assigned: Driver/vehicle assignment completed.
- Failed: Action failed and needs review.
- Completed: Ride or schedule item is finished.
- Available: Driver or vehicle can be used.
- Busy: Driver or vehicle is currently occupied.
- Offline: Driver or vehicle should not be selected.

## Simple Demo Script

1. Send or import a sample ride.
2. Show it in Rides / Final Bid.
3. Approve it in Final Bid.
4. Click Generate AI Now.
5. Approve the recommendation.
6. Show Assigned Driver in Final Bid.
7. Show Driver Schedule and Vehicle Schedule.
8. Show Calendar status.
9. Create a Bid entry and mark it approved/done.
10. Click Complete on the schedule row.
11. Show driver and vehicle available again.
12. Show Needs Review edit/save/move flow with an incomplete ride.

## Troubleshooting

### WhatsApp QR Appears

Open `/qr`, scan the QR code using WhatsApp linked devices, then wait for WhatsApp connected status.

### Calendar Failed

Check Calendar readiness cards. If Calendar and Calendar ID are ready, click Retry Calendar. If it fails again, check the error in Final Bid Calendar Error.

### OTS Import Not Ready

Check OTS Rows and OTS Pipeline cards. OTS import needs the formatted rows file or working OTS pipeline path.

### Auto Bid Not Ready

Safe mode can track approved bids without submitting. Live mode needs the OTS submitter script and valid OTS session/credentials.

### AI Recommendation Missing

Check that:
- The ride is in Final Bid.
- Ride is not rejected/completed.
- Ride has pickup, drop-off, date, time, fare, and vehicle.
- Drivers and vehicles are available.
- Driver/vehicle schedules do not conflict.

## Important Notes

- Rides are filtered by the configured area codes.
- Raw Rides sheet is kept as ingestion history.
- Operators should use the dashboard for daily work.
- Google Sheets remain the backing data store.
- OTS live auto-bid must be tested with real credentials before claiming full live production readiness.
