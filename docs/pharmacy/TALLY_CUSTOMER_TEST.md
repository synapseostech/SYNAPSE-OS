# Tally readiness check — customer instructions

This checks whether the pharmacy's Tally can be read by Synapse. **It is not the
migration.** It reads only, changes nothing in Tally, and stops on its own. It
uploads nothing: everything stays in one folder on the desktop, which you send
back yourself.

Allow about ten minutes. You will need:

- The computer that runs Tally, with Tally **open**, signed in, and the
  pharmacy's company selected.
- Tally's owner or accountant nearby, in case Tally asks for a password.
- Permission to send one small folder back to us.

---

## Step 1 — Run the check

1. Put the file `tally-probe.ps1` on the desktop of the Tally computer.
2. Right-click it and choose **Run with PowerShell**.
   If that option is missing, open a Command Prompt and run:

   ```
   powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\Desktop\tally-probe.ps1"
   ```

   The `-ExecutionPolicy Bypass` part is only for this one run; it changes no
   setting on the computer.

3. A black window opens and prints what it is doing. It asks at most two
   questions:
   - **"Type the number of the company to test"** — type the number beside the
     pharmacy's company and press Enter.
4. When it finishes, a folder called `SynapseTallyProbe` opens on the desktop.

If Tally is not running or not answering, the window will say so and stop. Fix
that and run it again — nothing is left half-done.

---

## Step 2 — Send it back

Send the whole `SynapseTallyProbe` folder, or zip it first and send the zip.

The folder holds three Tally files and one report:

| File | What it holds |
|---|---|
| `tally-probe-report.txt` | Plain-English answers. Always send this. |
| `1-companies.xml` | Company names only. |
| `2-masters.xml` | Account and stock item lists. |
| `3-day-book.xml` | Sales, purchases and other transactions. |

The report names the Tally edition and version, says whether Tally answered,
lists the open companies and the one tested, shows which record types the
masters actually returned, lists every opening and closing balance field Tally
itself emitted, counts the vouchers in the history, and gives a size verdict
against the 25 MB limit. It also times each request: if Tally takes more than a
minute to produce a file, it says so, because our live connection gives up after
one minute and that data would have to be uploaded as a file instead.

Files 2 and 3 contain the pharmacy's account and transaction details. Send them
only through a channel your own policy allows — email to a known address, or the
shared drive we set up with you. **Do not** upload them to a public file-sharing
link. The report alone still answers most of our questions.

If you would rather not send 2 and 3, send the report and tell us; we will tell
you what is still missing.

---

## Step 3 — What we do with it

We read the report and come back with one of three answers:

- **Ready.** Tally can be read and the data fits or needs splitting. We then
  agree a migration date.
- **Needs a setting change.** Usually Tally's HTTP server is off, or the wrong
  company is open. We tell you exactly what to change and you run the check
  again.
- **Needs a different route.** If Tally cannot be read over the network, we
  switch to exporting the file by hand from Tally and uploading it.

Nothing is written into Synapse until a separate, reviewed step that you
approve.

---

## If the window stops with a message

| Message | What it means | What to do |
|---|---|---|
| `nothing is listening on port 9000` | Tally's network gateway is switched off | In Tally press **F1 → Settings → Advanced Configuration** and enable the HTTP/gateway server on port 9000. The wording differs between TallyPrime and Tally.ERP 9; ask your Tally dealer if you cannot find it. |
| `Tally did not answer the company list` | Tally is open but refused the request | Make sure you are signed in and a company is open, then run again |
| `Tally answered but named no company` | No company is open | Open the pharmacy company in Tally |
| `the history could not be read` | The history could not be exported | Tell us the message — it usually means the date range is restricted |
| `the masters response does not name its company` | This Tally build does not say which company a reply belongs to | Send the folder anyway — this is exactly what we need to see |
| `the history response does not name its company` | Same, for the transaction file | Send the folder anyway |
| `VERDICT: BLOCKED` | The history is too large to import in one step | Send the folder; we agree what period to start with |
| The window flashes and closes | The script was blocked | Run it with the Command Prompt command in Step 1 |

If you are unsure at any point, stop and send us a photograph of the window.
Nothing in this check can damage Tally or its data.
