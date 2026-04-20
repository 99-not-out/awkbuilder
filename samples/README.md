# samples

Test inputs for exercising awkbuilder. Each file targets a different
field-separation / record-boundary scenario so you can iterate on the
tricky bits of awk program design.

| file                 | FS suggestion      | notes                                               |
|----------------------|--------------------|-----------------------------------------------------|
| `access.log`         | `" "` (default)    | Apache-style; `$1` IP, `$9` status, `$10` bytes     |
| `syslog.log`         | `" "` (default)    | Timestamps span `$1..$3`; `$5` is program[pid]:     |
| `users.csv`          | CSV mode           | Has a header row, embedded commas, and quoted field |
| `metrics.tsv`        | `\t` (TSV)         | Tabular; good for per-host aggregations             |
| `pipes.txt`          | `\|`               | Trading orders, `\|` field separator                |
| `multiline.txt`      | RS=`""`, FS=`\n`   | Paragraph records (blank-line separated)            |
| `fixed-width.txt`    | FIELDWIDTHS / substr | Columns live at fixed offsets, not separators    |
| `json-lines.jsonl`   | (regex helpers)    | One JSON object per line; needs regex / match()     |

## Quick starts

Count requests per IP in the access log:

    awk '{ ip[$1]++ } END { for (k in ip) print ip[k], k }' samples/access.log

Sum bytes by status code:

    awk '{ s[$9] += $10 } END { for (k in s) printf "%-3s %d\n", k, s[k] }' samples/access.log

Users with more than 100 credits:

    awk -F, 'NR>1 && $6>100 { print $2 " (" $6 ")" }' samples/users.csv

Ticket severities from multiline records:

    awk 'BEGIN{RS=""; FS="\n"} { for (i=1;i<=NF;i++) if ($i ~ /^Severity:/) print $i }' samples/multiline.txt
