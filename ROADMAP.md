# ROADMAP.md — upcoming work

Agreed items are ready to build. Proposed items are written up so the reasoning is
visible before anyone commits to them. Completed items move to DECISIONS.md.

## 1. Password reset and account hardening (done, see DECISIONS #024)

## 2. "Where do these files go, and what if I have no project yet?" (done, see DECISIONS #025)

## Ideas not yet scheduled

- Email-based self-service password reset, reusing the `password_resets` table, if the
  user base ever outgrows admin-issued codes.
- A Django settings snippet in Getting started for wiring `DATABASE_URL`, if enough users
  hit that step.
- A YAML parser for the Mode 3 checker (see DECISIONS #013) if its regexes start missing
  legitimate compose files.
