# LurukaPS

![LurukaPS](images/LurukaPS.webp)

LurukaPS is a server emulator for the Azur Promilia CBT3 client. It implements networking and gameplay logic in Node.js and uses SQLite to persist accounts, characters, and game state.

The project is under active development.

AzurJS was the project's former internal name.

[Telegram Channel](https://t.me/LurukaPS) | [Telegram Group](https://t.me/+VY_nbsZQeVc0YTdh)

![Example](images/example.jpg)

## Features

- TCP game connections, HTTP discovery and login endpoints, protocol encoding and decoding, and request replay handling.
- Account and character persistence, character creation, formations, inventory, currencies, and basic progression.
- Task graphs and conditions, story callbacks, world objects, events, and partial combat synchronization.
- Pet capture, hatching, and progression, plus home building, production, farming, and cooking workflows.
- Chat, mail, shops, locally simulated orders, and GM commands.

## Requirements

- **Node.js 22 or later** and npm.
- Protocol schemas and game data matching the target client.
- A native build toolchain if `better-sqlite3` has no prebuilt binary for your platform.

## Game Data

Download the external dataset from [PackageInstaller/DataTable — Azur Promilia](https://github.com/PackageInstaller/DataTable/tree/game/AzurPromilia).

To clone only the game's snapshot branch, run this from the parent directory of LurukaPS:

```powershell
git clone --branch game/AzurPromilia --single-branch --depth 1 https://github.com/PackageInstaller/DataTable.git DataTable
```

LurukaPS includes its internal static configuration in `configs/`, but still requires external tables and task graphs. Arrange the downloaded data in the following layout, or configure a custom table path:

```text
workspace/
├── LurukaPS/
│   ├── src/                         # Server source
│   ├── test/                        # Automated tests
│   ├── proto/lua/proto/             # Runtime .proto schemas
│   ├── configs/                     # Internal tables, protocol map, and wire key
│   └── data/                        # Runtime databases and logs
└── DataTable/
    └── MasterData/
        ├── Tables/                  # Full game tables
        └── Config/Task/             # task_client_<id>.json task graphs
```

`LURUKAPS_TABLES` can point to a custom `Tables/` directory. Task graphs are resolved relative to that directory at `../Config/Task`. Both tables and task graphs must match the target client version.

## Quick Start

From the LurukaPS project directory:

```powershell
npm ci
npm start
```

By default, the server listens on `127.0.0.1`, using TCP port **20002** for the game connection and HTTP port **20001** for discovery and login endpoints. Configure or redirect the client to these endpoints.

To use a custom dataset and ports:

```powershell
$env:LURUKAPS_TABLES = 'D:\GameData\MasterData\Tables'
$env:LURUKAPS_GAME_PORT = '20002'
$env:LURUKAPS_HTTP_PORT = '20001'
npm start
```

For a LAN connection, set the listening address and an advertised address reachable by the client:

```powershell
$env:LURUKAPS_HOST = '0.0.0.0'
$env:LURUKAPS_PUBLIC_HOST = '192.168.1.100' # Replace with the server's LAN IP
npm start
```

Configuration is read from process environment variables. `.env` files are not loaded automatically.

### Using the Bundled CBT3 Client Shell

`tools/shell/build/AzurPromilia.exe` is a Windows x64 replacement for the matching CBT3 client's original executable. **Replace the game's original `AzurPromilia.exe` with this file**, keeping the same filename. `tools/shell/build/cbt3-shell.ini` is its optional configuration.

1. Start LurukaPS with `npm start` and leave the server running.
2. Close the game and back up its original `AzurPromilia.exe`.
3. Overwrite the original game EXE with `tools/shell/build/AzurPromilia.exe`, and place `cbt3-shell.ini` beside it.

Run the replaced `AzurPromilia.exe` from the game directory. Keep the original `UnityPlayer.dll`, `GameAssembly.dll`, and `AzurPromilia_Data/` in place. In the account window, enter a local `open_id`, such as `114514`, and click **启动游戏** (Start Game). Reuse the same ID to access the same saved account; **记住账号，下次预填** remembers it in the INI for the next launch. To restore the original client entry point, replace the shell EXE with your backup.

In the choose server window, select **Release**, **LurukaPS** and numbers like `2451868.2451868.2451868.2451868.2302423`. Then click **进入游戏** (Enter Game) to connect to the server. The game will create a new character if none exists.

The default `api_url=http://127.0.0.1:20001` is suitable when the server and game run on the same machine. For LAN use, edit `api_url` in the game's `cbt3-shell.ini` to match the server's reachable HTTP address, for example `http://192.168.1.100:20001`, and configure `LURUKAPS_PUBLIC_HOST` as shown above. Camera fading is disabled by default; set `disable_camera_fade=0` to restore it.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LURUKAPS_HOST` | `127.0.0.1` | Listening address |
| `LURUKAPS_PUBLIC_HOST` | `127.0.0.1` | Connection address advertised to the client |
| `LURUKAPS_GAME_PORT` | `20002` | Game TCP port |
| `LURUKAPS_HTTP_PORT` | `20001` | HTTP port |
| `LURUKAPS_TABLES` | `../DataTable/MasterData/Tables` | External game table directory |
| `LURUKAPS_DB` | `data/azur.sqlite` | SQLite file; the existing path preserves saved state |
| `LURUKAPS_DIAGNOSTICS_FILE` | `data/protocol-errors.jsonl` | Protocol diagnostics; an empty string disables logging |
| `LURUKAPS_SERVER_NAME` | `LurukaPS` | Server name |
| `LURUKAPS_SERVER_DESC` | `LurukaPS CBT3 local server` | Server description |
| `LURUKAPS_ENABLE_GM` | Enabled | Set to `0` to disable GM commands |
| `LURUKAPS_OFFLINE_PAYMENTS` | Enabled | Set to `0` to disable locally simulated orders |
| `LURUKAPS_STRONG_ENCRYPTION` | Disabled | Set to `1` to enable optional strong encryption negotiation |
| `LURUKAPS_CRC_DELAY` | `0` | Delayed CRC verification setting |
| `LURUKAPS_STATE_FLUSH_MS` | `5000` | Deferred state flush interval in milliseconds |

Additional discovery settings include `LURUKAPS_VERSION`, `LURUKAPS_HOT_REVISION`, `LURUKAPS_JOB_NAME`, `LURUKAPS_SERVER_TAG`, `LURUKAPS_SERVER_ID`, and `LURUKAPS_CLIENT_LOG`.

The corresponding legacy `AZUR_*` variables remain supported. When both namespaces are configured, `LURUKAPS_*` takes precedence.

## Connection Protocol Flow

The CBT3 client uses the following connection sequence to establish a game session:

1. **HTTP CONNECT tunnel** — The client connects to the game TCP port and sends an `HTTP CONNECT` request (e.g., `CONNECT 36.155.186.181:10012 HTTP/1.1`). The server must respond with `HTTP/1.1 200 Connection Established\r\n\r\n` before the client proceeds to framed protocol messages.

2. **Handshake (id=321)** — After the tunnel is established, the client sends a framed message with message ID `321` (not in the protocol map, internal networking handshake) and flag `0x01` (wire obfuscation, not LZ4 compression). The server acknowledges the frame even without a dedicated handler; the flag-1-without-compression case is handled gracefully.

3. **TLS upgrade** — The client then initiates a TLS 1.2 handshake (Client Hello, `0x16030301`). The game protocol runs inside this TLS session. Full TLS termination on the server side is **not yet implemented** — a `tls.TLSSocket` wrapper around the raw TCP socket with a self-signed certificate is the expected solution.

### Known limitations

- TLS termination is required after the initial handshake; the server currently rejects TLS Client Hello as an invalid frame length.
- Message ID `321` has no protobuf schema registered; only the internal low-level network layer handles it.
- The `tls: false` flag in the PatchV1 discovery response does **not** prevent the client from using TLS on the game connection.

## Saved Data

`configs/` and `.proto` files are static inputs maintained with the source. Runtime data is written to `data/`. The server creates the database directory when needed.

Back up your database before upgrading. Stop the server before copying database files, and keep existing saved state when updating code.

## Disclaimer

LurukaPS is an unofficial game server emulator intended solely for learning and protocol research. It is not affiliated with, endorsed by, or supported by the developers, publishers, or operators of Azur Promilia.

**Commercial use is strictly prohibited.** This includes operating paid services, charging for access or in-game benefits, selling the emulator or services based on it, and any other commercial exploitation of the project. Use is limited to non-commercial learning and research.

All game names, trademarks, characters, artwork, client software, and other original game assets belong to their respective rights holders. This project does not grant permission to use or distribute those materials. Links to external datasets are provided for reference and do not imply ownership, authorization, or endorsement.

Users are responsible for ensuring that their use of this project and any associated client software or data complies with applicable laws, licenses, and agreements. Do not use this project to interfere with official services, access systems without authorization, infringe third-party rights, or operate an unauthorized commercial service. The maintainers do not endorse or assist such uses.

The software is provided "AS IS", without warranties of any kind, to the extent permitted by applicable law. Compatibility, completeness, security, and preservation of saved data are not guaranteed. Use it at your own risk and maintain backups. Nothing in this disclaimer limits rights or obligations that cannot be excluded under applicable law, or replaces the terms of the project's applicable license.

Rights holders with concerns may contact the repository maintainers through the project's issue tracker for review.
