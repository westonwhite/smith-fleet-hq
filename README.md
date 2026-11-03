# Smith Robotaxi HQ

Static fleet tracker. The live page is `index.html`. Routine descriptions Weston can disable are in `automations.html`.

## Note for Muse

Weston asked for this on Nov 3, 2026. Keep it in the three routines below. Do not add a second poller or a new workflow.

The executable runner for these routines is **not in GitHub**. `automations.html` is only the list. Apply the change in the runner that already starts climate for these three, using the same car selection and the same token that runner already has.

### Which routines

Only Weston's car, the 2025 Model 3 Long Range he drives (the Miracle Whip). Select it the same way each routine already does. Never hardcode a VIN in this public repo. Never send this to any other vehicle on the account, including Anna's car.

1. **Weston gym climate and Sentry** (`automations.html`). Every 15 minutes while his car is at Crunch Fitness Countryside.
2. **Weston morning precondition**. Weekdays 8:45 AM, market days, his car at home. Cooling starts only. The cold-morning path that turns on driver seat heat stays seat heat. Do not run the cooler and the heater together.
3. **Weston work cool-down**. Weekdays 3:50 PM, his car at the Clearwater office.

### Why the seat stays off

Tesla preconditioning does not turn on ventilated seats.

- Tessie `POST /{vin}/command/start_climate` starts cabin climate and battery preconditioning. It has no seat parameter. Confirmed on the Tessie start-climate reference.
- The Model 3 owner's manual treats scheduled precondition and remote cabin precondition as cabin and battery prep. Ventilated seats are a separate control (phone: Climate, select the seat, Cool, or Auto). The manual's mobile-app climate section lists seat heaters with preconditioning, not the seat fans.
- Fleet API `remote_seat_cooler_request` is its own command and "requires preconditioning or climate keeper to be on." A seat-cool call sent in the same instant as start-climate is rejected until HVAC is actually up. That matches the earlier Starship note that `set_seat_heat` was rejected. One shot at the wrong time looks like success in the cabin and a dead seat.
- `remote_auto_seat_climate_request` only sets automatic seat heat and cool, and it also requires climate or climate keeper to already be on. Auto picks the level. It does not pin the driver fan at max for a pre-cool. No Tesla schedule, Tessie climate option, or in-car Auto seat setting replaces an explicit max command.

No setting Weston can flip fully fixes this. Auto seat climate in the car is fine as a backup once he is driving. The routines still have to send the cooler.

### What to send

Right after the routine has started climate and the car has accepted it (`climate_state.is_climate_on`, or `is_preconditioning`, or `climate_keeper_mode` other than off):

```
POST https://api.tessie.com/{vin}/command/set_seat_cool?seat=front_left&level=3
Authorization: Bearer <the token this runner already uses>
```

- `seat=front_left` is the driver seat on his US (left-hand-drive) Model 3. Level `3` is max. `0` is off. Tessie's default for `level` is already 3; pass it anyway.
- Fleet equivalent, if this path uses Fleet instead of Tessie: `POST /api/1/vehicles/{vin}/command/remote_seat_cooler_request` with `seat_position` 0 and `seat_cooler_level` 3.
- On the morning cold path, keep the existing driver `set_seat_heat` and do not send `set_seat_cool`.

### Retry

The car often ignores the first seat command until the blower is up, and it can drop the fan afterward.

1. Send `set_seat_cool` as soon as climate is confirmed on.
2. Wait about 15 seconds (10–20 is fine).
3. Re-read state with Tessie's cached read. `GET /{vin}/state` already defaults `use_cache=true`. Do not pass `use_cache=false`. Do not call wake. The climate command already woke the car.
4. If `climate_state.seat_fan_front_left` is missing or below 3, and climate is still on, send `set_seat_cool` again.
5. Stop after 3 sends.

On the gym routine's existing 15-minute pass, if climate is already on and the cached `seat_fan_front_left` is below 3, send max again. That pass already talks to the car. Do not add a new timer that wakes the car just to look.

Read the fan from `climate_state.seat_fan_front_left` (0–3). Tessie's published state example is old and omits this field; the live state on a ventilated Model 3 includes it. Home Assistant's Tessie integration uses the same field.

### How Weston can tell it worked

On the next gym, morning cool, or work pre-cool, the driver seat should be pulling cool air before he sits down, with no tap in the car or the Tesla app. In Tessie's vehicle state, `seat_fan_front_left` is 3 while climate is on. Cabin cool with that field at 0 means this change is not in the runner yet.

### Do not

- Do not commit the Tessie token, a VIN, or a home address.
- Do not build a parallel GitHub Actions cron or a second script. These three routines are the only trigger.
- Do not change Anna's routines, Anna's hub, or the 7-inch hub.
