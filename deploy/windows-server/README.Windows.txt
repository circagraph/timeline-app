Circagraph server for Windows
=============================

Install
-------

Run circagraph-server-windows-amd64-setup.exe (as an administrator; it asks). It installs
into C:\Program Files\Circagraph Server everything the server needs: its own PostgreSQL 17
with the pgmp extension, Node.js 24, the platform and the SQLite converter. It then:

  - writes C:\ProgramData\Circagraph\circagraph.env (readable only by administrators
    and the server), with a new AUTH_ENCRYPTION_KEY and the database's password;
  - initializes PostgreSQL in C:\ProgramData\Circagraph\pgdata, listening on
    127.0.0.1:5442 only, as the CircagraphPostgreSQL service (Network Service account);
    its superuser password is in postgres-superuser.txt beside the configuration;
  - creates the circagraph database with pgmp and migrates it;
  - starts the Circagraph service (Local Service account), which listens on
    127.0.0.1:5173. Both services start with Windows;
  - installs the CircagraphSyslog (syslog receiver), CircagraphGitHub (GitHub
    receiver) and CircagraphMail (account email) services, which start only once you
    configure and start them (below).

Unattended: circagraph-server-windows-amd64-setup.exe /S (exit code 2 when setup did not
finish). Setup writes C:\ProgramData\Circagraph\setup.log; it is safe to run again, as an
administrator: powershell -ExecutionPolicy Bypass -File "C:\Program Files\Circagraph
Server\setup.ps1".

Setup makes C:\ProgramData\Circagraph the administrators' and replaces its access list
each time. Any user may create a folder in ProgramData, so if one exists before the first
install holding files that no administrator (nor the system) owns, setup stops rather than use
a configuration, password or database another account may have planted: delete the folder or
move it aside, then install again. If they are an earlier installation's files and you have
checked them, run setup.ps1 as above with -TrustExistingData. Installed somewhere other than
Program Files, the program's folder gets Program Files' access: users and the services read
and run it, and only administrators and the system change it.

Configure
---------

Edit C:\ProgramData\Circagraph\circagraph.env as an administrator, then restart the
Circagraph service (Services, or Restart-Service Circagraph):

  - APP_ORIGIN: the public HTTPS origin users reach, without a trailing slash. The server
    refuses a plain http:// origin other than localhost; on a trusted private network without
    a proxy, set ALLOW_INSECURE_ORIGIN=1 and HOST=0.0.0.0 to serve http://<name>:5173
    directly (and allow port 5173 in Windows Defender Firewall). The server's log is in
    C:\ProgramData\Circagraph\logs; if the website reports "Server misconfigured", the
    reason is there.
  - ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD for the first administrator,
    created by circagraph-migrate. The password is used once; to sign in with it again
    (or with a new one written there), run circagraph-reset-admin-password. Once you
    have signed in and changed it, blank ADMIN_INITIAL_PASSWORD, so the file no longer holds
    it; write one there again only to reset.
  - Sign-in providers, human verification, quotas: see the comments in the file and
    authentication.md, administration.md in the doc folder.

Account email: set RESEND_API_KEY and AUTH_EMAIL_FROM there, then, in PowerShell as an
administrator:

  Set-Service CircagraphMail -StartupType Automatic; Start-Service CircagraphMail

Syslog to timelines (syslog.md): the CircagraphSyslog service receives syslog over UDP
and TCP on 127.0.0.1:5514 and adds each message to the timelines its routes choose. Write the
routes into C:\ProgramData\Circagraph\syslog-routes.json and set OCH_API_KEY (a read/write
API key from Account > API keys) in C:\ProgramData\Circagraph\syslog.env, then:

  Set-Service CircagraphSyslog -StartupType Automatic; Start-Service CircagraphSyslog

Both run as Local Service and log to C:\ProgramData\Circagraph\logs; restart a service
after editing its configuration (Restart-Service CircagraphSyslog). Setup makes syslog.env
and syslog-routes.json readable by Local Service. Edit them in place (Notepad does); a file
replaced or written anew there is readable by administrators only, until you grant it again
(icacls <file> /grant "*S-1-5-19:R") or run setup again, which sets each file's access. To receive from other machines, set SYSLOG_HOST=0.0.0.0
and allow the port in Windows Defender Firewall, on a trusted network only: the receiver has
no TLS or sender authentication.

GitHub to timelines (github.md): the CircagraphGitHub service receives GitHub's webhooks
on 127.0.0.1:5580, behind your HTTPS reverse proxy, and mirrors issues and pull requests into
the timelines its routes choose. Write the routes into
C:\ProgramData\Circagraph\github-routes.json and set OCH_API_KEY and
GITHUB_WEBHOOK_SECRET in C:\ProgramData\Circagraph\github.env, then:

  Set-Service CircagraphGitHub -StartupType Automatic; Start-Service CircagraphGitHub

It runs as Local Service too, logs beside the others and keeps its state in
C:\ProgramData\Circagraph\github-state. Setup makes github.env and github-routes.json
readable by Local Service, as it does syslog.env.

The commands are in C:\Program Files\Circagraph Server; run them as an administrator:

  circagraph-migrate                 migrates the database and restarts the services
  circagraph-reset-admin-password    the administrator's password, from the configuration
  cg-import-logs                     imports log files (log-import.md)
  cg-import-github                   imports GitHub issues and pull requests (github.md)

Their names until 0.30 (openchronology-migrate, openchronology-reset-admin-password,
och-import-logs and och-import-github) run them too.

Back up AUTH_ENCRYPTION_KEY apart from the database: without it, enrolled authenticator
secrets cannot be decrypted. Do not change it once accounts exist.

Serve it publicly through an HTTPS reverse proxy (Caddy, IIS with URL Rewrite and ARR, or
nginx) forwarding to http://127.0.0.1:5173.

Upgrade
-------

Run the newer installer. It stops the services, replaces the program, keeps the configuration
and the database, migrates the database to the new version and starts the services again
(CircagraphMail, CircagraphSyslog and CircagraphGitHub only if they start with Windows).
Running circagraph-migrate by hand restarts the server, and CircagraphMail, CircagraphSyslog
and CircagraphGitHub, each if it starts with Windows. Back up first:

  "C:\Program Files\Circagraph Server\pgsql\bin\pg_dump.exe" -h 127.0.0.1 -p 5442 ^
    -U postgres circagraph > circagraph.sql

(with the password in C:\ProgramData\Circagraph\postgres-superuser.txt). Compare the
configuration with this version's template in C:\Program Files\Circagraph Server\templates.

Upgrade from OpenChronology Server
---------------------------------

Circagraph Server was OpenChronology Server until 0.30. Back up as above, with the old names
(C:\Program Files\OpenChronology Server\pgsql\bin\pg_dump.exe, the openchronology
database, C:\ProgramData\OpenChronology\postgres-superuser.txt), then run this installer.
It takes the old installation's place:

  - it stops OpenChronology, OpenChronologyPostgreSQL, OpenChronologySyslog,
    OpenChronologyGitHub and OpenChronologyMail and removes them, noting which of the last
    three started with Windows;
  - it moves C:\ProgramData\OpenChronology, the configuration and the database, to
    C:\ProgramData\Circagraph, leaving C:\ProgramData\OpenChronology as a link to it,
    renames openchronology.env to circagraph.env, and changes the paths in the .env files
    that named the old folder;
  - it removes C:\Program Files\OpenChronology Server with OpenChronology Server's own
    uninstaller (which keeps the configuration and database) and its entry in Settings >
    Apps;
  - it then sets up as an upgrade: the database and its role keep their name,
    openchronology, as DATABASE_URL says, and are migrated; the Circagraph services
    replace the old ones, and CircagraphSyslog, CircagraphGitHub and CircagraphMail start
    with Windows where their old services did.

Windows services have no second names: scripts that used Restart-Service OpenChronology (or
the other old service names) need the new ones. If setup stops part way, run setup.ps1 again
as above: it goes on where it stopped.

Remove
------

Settings > Apps > Circagraph Server > Uninstall (or uninstall.exe /S). The services and
the program are removed; the configuration (including AUTH_ENCRYPTION_KEY) and the database
remain in C:\ProgramData\Circagraph: delete that folder to remove them as well (and
C:\ProgramData\OpenChronology, the link an upgrade from OpenChronology Server leaves, if it
is there).
