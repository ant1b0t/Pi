#!/usr/bin/env bash
#
# Research Script — Parallel web search using Exa and Tavily APIs
# 
# Usage: ./research.sh "<query>" [max_results] [mode]
#   query:       Search query (required)
#   max_results: Number of results 5-20 (default: 10)
#   mode:        fast (default) | synthesis
#
# Output: JSON with results or error
#
# Example:
#   ./research.sh "kubernetes best practices" 10 fast
#

set -euo pipefail

# ── Configuration ────────────────────────────────

CACHE_DIR=".pi/research-cache"
CACHE_TTL=300  # 5 minutes in seconds
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Try to find project root - check multiple locations
if [[ -f "$SCRIPT_DIR/../../../.env" ]]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
elif [[ -f "$SCRIPT_DIR/../../.env" ]]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [[ -f ".env" ]]; then
    PROJECT_ROOT="$(pwd)"
else
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

# ── Load .env file ───────────────────────────────

load_env() {
    local env_file="$PROJECT_ROOT/.env"
    if [[ -f "$env_file" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            # Skip comments and empty lines
            [[ "$line" =~ ^[[:space:]]*# ]] && continue
            [[ -z "$line" ]] && continue
            
            # Parse KEY=VALUE
            if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
                local key="${BASH_REMATCH[1]}"
                local value="${BASH_REMATCH[2]}"
                # Remove quotes if present
                value="${value%\"}"
                value="${value#\"}"
                value="${value%\'}"
                value="${value#\'}"
                
                # Export only if not already set
                if [[ -z "${!key:-}" ]]; then
                    export "$key=$value"
                fi
            fi
        done < "$env_file"
    fi
}

# ── Find jq executable ───────────────────────────

find_jq() {
    # Check if jq is in PATH (works on both Ubuntu and Windows)
    if command -v jq &> /dev/null; then
        echo "jq"
        return 0
    fi
    
    # Common Windows locations (Git Bash format)
    if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "${WINDIR:-}" ]]; then
        local windows_jq="/c/Users/${USERNAME:-$USER}/AppData/Local/Microsoft/WinGet/Packages/jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe"
        
        if [[ -f "$windows_jq" ]]; then
            echo "$windows_jq"
            return 0
        fi
        
        # Try with .exe extension
        if command -v jq.exe &> /dev/null; then
            echo "jq.exe"
            return 0
        fi
    fi
    
    # Ubuntu/Debian common location
    if [[ -f "/usr/bin/jq" ]]; then
        echo "/usr/bin/jq"
        return 0
    fi
    
    return 1
}

JQ_CMD=""

# ── Check dependencies ───────────────────────────

check_dependencies() {
    if ! JQ_CMD=$(find_jq); then
        local install_msg
        if [[ "$OSTYPE" == "linux-gnu"* ]] || [[ -f "/etc/debian_version" ]]; then
            install_msg="sudo apt-get install jq"
        elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "${WINDIR:-}" ]]; then
            install_msg="winget install jqlang.jq or download from https://jqlang.github.io/jq/download/"
        else
            install_msg="Install jq for your platform from https://jqlang.github.io/jq/download/"
        fi
        echo "{\"success\":false,\"error\":\"jq is required but not installed\",\"details\":{\"install\":\"$install_msg\"}}"
        exit 1
    fi
    
    if ! command -v curl &> /dev/null && ! command -v curl.exe &> /dev/null; then
        local curl_msg
        if [[ "$OSTYPE" == "linux-gnu"* ]] || [[ -f "/etc/debian_version" ]]; then
            curl_msg="sudo apt-get install curl"
        else
            curl_msg="curl should be pre-installed on Windows 10+"
        fi
        echo "{\"success\":false,\"error\":\"curl is required but not installed\",\"details\":{\"install\":\"$curl_msg\"}}"
        exit 1
    fi
}

# ── API Key Management ───────────────────────────

get_exa_key() {
    for i in 1 2 3 4; do
        local var_name="EXA_API_KEY_$i"
        local key="${!var_name:-}"
        if [[ -n "$key" && "$key" != "your_key"* ]]; then
            echo "$key"
            return 0
        fi
    done
    return 1
}

get_tavily_key() {
    for i in 1 2 3 4; do
        local var_name="TAVILY_API_KEY_$i"
        local key="${!var_name:-}"
        if [[ -n "$key" && "$key" != "your_key"* && "$key" != "tvly-YOUR"* ]]; then
            echo "$key"
            return 0
        fi
    done
    return 1
}

# ── Cache Functions ──────────────────────────────

get_cache_key() {
    local query="$1"
    local max_results="$2"
    echo -n "${query}:${max_results}" | sha256sum | cut -d' ' -f1 | cut -c1-16
}

get_cache_path() {
    local key="$1"
    echo "$PROJECT_ROOT/$CACHE_DIR/${key}.json"
}

ensure_cache_dir() {
    local cache_path="$PROJECT_ROOT/$CACHE_DIR"
    if [[ ! -d "$cache_path" ]]; then
        mkdir -p "$cache_path"
    fi
}

get_cached_result() {
    local query="$1"
    local max_results="$2"
    local key
    key=$(get_cache_key "$query" "$max_results")
    local cache_file
    cache_file=$(get_cache_path "$key")
    
    if [[ -f "$cache_file" ]]; then
        local age
        age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null || echo 0)))
        
        if [[ $age -lt $CACHE_TTL ]]; then
            cat "$cache_file"
            return 0
        fi
    fi
    
    return 1
}

set_cached_result() {
    local query="$1"
    local max_results="$2"
    local result="$3"
    
    ensure_cache_dir
    local key
    key=$(get_cache_key "$query" "$max_results")
    local cache_file
    cache_file=$(get_cache_path "$key")
    
    echo "$result" > "$cache_file"
}

# ── Search Functions ─────────────────────────────

search_exa() {
    local query="$1"
    local max_results="$2"
    local api_key
    
    if ! api_key=$(get_exa_key); then
        echo '{"error":"No Exa API key configured"}'
        return 1
    fi
    
    local response
    if ! response=$(curl -s -X POST "https://api.exa.ai/search" \
        -H "Content-Type: application/json" \
        -H "x-api-key: $api_key" \
        -d "{
            \"query\": \"$query\",
            \"num_results\": $max_results,
            \"use_autoprompt\": true,
            \"type\": \"neural\",
            \"contents\": {\"text\": true}
        }" 2>/dev/null); then
        echo '{"error":"Exa API request failed"}'
        return 1
    fi
    
    # Check for API errors
    if echo "$response" | $JQ_CMD -e 'has("error")' &>/dev/null; then
        local error_msg
        error_msg=$(echo "$response" | $JQ_CMD -r '.error // "Unknown Exa API error"')
        echo "{\"error\":\"Exa: $error_msg\"}"
        return 1
    fi
    
    echo "$response"
}

search_tavily() {
    local query="$1"
    local max_results="$2"
    local api_key
    
    if ! api_key=$(get_tavily_key); then
        echo '{"error":"No Tavily API key configured"}'
        return 1
    fi
    
    local response
    if ! response=$(curl -s -X POST "https://api.tavily.com/search" \
        -H "Content-Type: application/json" \
        -d "{
            \"query\": \"$query\",
            \"max_results\": $max_results,
            \"search_depth\": \"advanced\",
            \"include_answer\": false,
            \"include_raw_content\": true,
            \"api_key\": \"$api_key\"
        }" 2>/dev/null); then
        echo '{"error":"Tavily API request failed"}'
        return 1
    fi
    
    # Check for API errors
    if echo "$response" | $JQ_CMD -e 'has("error")' &>/dev/null; then
        local error_msg
        error_msg=$(echo "$response" | $JQ_CMD -r '.error // "Unknown Tavily API error"')
        echo "{\"error\":\"Tavily: $error_msg\"}"
        return 1
    fi
    
    echo "$response"
}

# ── Result Processing ────────────────────────────

normalize_exa_results() {
    local json="$1"
    echo "$json" | $JQ_CMD '[.results // [] | .[] | {
        title: (.title // "Untitled"),
        url: .url,
        content: (.text // ""),
        score: (.score // 0),
        source: "exa"
    }]'
}

normalize_tavily_results() {
    local json="$1"
    echo "$json" | $JQ_CMD '[.results // [] | .[] | {
        title: (.title // "Untitled"),
        url: .url,
        content: (.content // ""),
        score: (.score // 0),
        source: "tavily"
    }]'
}

merge_and_deduplicate() {
    local exa_json="$1"
    local tavily_json="$2"
    local max_results="$3"
    
    echo "$exa_json" "$tavily_json" | $JQ_CMD -s '
        add |
        group_by(.url) |
        map(
            if length > 1 then
                {
                    title: first.title,
                    url: first.url,
                    content: (map(.content) | join("\n\n[Additional content from alternate source]: ")),
                    score: (map(.score) | add / length),
                    sources: (map(.source) | unique)
                }
            else
                first + {sources: [first.source]}
            end
        ) |
        sort_by(.score) |
        reverse |
        .[0:'"$max_results"']
    '
}

# ── Main Function ────────────────────────────────

main() {
    # Load environment
    load_env
    
    # Check dependencies
    check_dependencies
    
    # Parse arguments
    local query="${1:-}"
    local max_results="${2:-10}"
    local mode="${3:-fast}"
    
    # Validate arguments
    if [[ -z "$query" ]]; then
        echo '{"success":false,"error":"Query is required","usage":"./research.sh \"<query>\" [max_results] [mode]"}'
        exit 1
    fi
    
    # Validate max_results
    if ! [[ "$max_results" =~ ^[0-9]+$ ]] || [[ "$max_results" -lt 5 ]] || [[ "$max_results" -gt 20 ]]; then
        max_results=10
    fi
    
    # Check cache
    local cached_result
    if cached_result=$(get_cached_result "$query" "$max_results" 2>/dev/null); then
        echo "$cached_result" | $JQ_CMD '.meta.cached = true'
        exit 0
    fi
    
    # Record start time
    local start_time
    start_time=$(date +%s%N 2>/dev/null || echo "$(date +%s)000000000")
    
    # Parallel search
    local exa_result=""
    local tavily_result=""
    local exa_error=""
    local tavily_error=""
    
    # Search Exa in background
    (
        exa_result=$(search_exa "$query" "$max_results")
        if [[ $? -eq 0 ]]; then
            echo "$exa_result" > /tmp/exa_result_$$
        else
            echo "$exa_result" > /tmp/exa_error_$$
        fi
    ) &
    local exa_pid=$!
    
    # Search Tavily in background
    (
        tavily_result=$(search_tavily "$query" "$max_results")
        if [[ $? -eq 0 ]]; then
            echo "$tavily_result" > /tmp/tavily_result_$$
        else
            echo "$tavily_result" > /tmp/tavily_error_$$
        fi
    ) &
    local tavily_pid=$!
    
    # Wait for both
    wait $exa_pid || true
    wait $tavily_pid || true
    
    # Read results
    if [[ -f /tmp/exa_result_$$ ]]; then
        exa_result=$(cat /tmp/exa_result_$$)
        rm -f /tmp/exa_result_$$
    elif [[ -f /tmp/exa_error_$$ ]]; then
        exa_error=$(cat /tmp/exa_error_$$)
        rm -f /tmp/exa_error_$$
    fi
    
    if [[ -f /tmp/tavily_result_$$ ]]; then
        tavily_result=$(cat /tmp/tavily_result_$$)
        rm -f /tmp/tavily_result_$$
    elif [[ -f /tmp/tavily_error_$$ ]]; then
        tavily_error=$(cat /tmp/tavily_error_$$)
        rm -f /tmp/tavily_error_$$
    fi
    
    # Check if both failed
    if [[ -z "$exa_result" && -z "$tavily_result" ]]; then
        local error_details="{}"
        if [[ -n "$exa_error" ]]; then
            error_details=$(echo "$error_details" | $JQ_CMD --arg err "$exa_error" '.exa = $err')
        fi
        if [[ -n "$tavily_error" ]]; then
            error_details=$(echo "$error_details" | $JQ_CMD --arg err "$tavily_error" '.tavily = $err')
        fi
        
        echo "{\"success\":false,\"error\":\"Both search providers failed\",\"details\":$error_details}"
        exit 1
    fi
    
    # Normalize results
    local exa_normalized="[]"
    local tavily_normalized="[]"
    
    if [[ -n "$exa_result" ]]; then
        exa_normalized=$(normalize_exa_results "$exa_result")
    fi
    
    if [[ -n "$tavily_result" ]]; then
        tavily_normalized=$(normalize_tavily_results "$tavily_result")
    fi
    
    # Merge and deduplicate
    local merged
    merged=$(merge_and_deduplicate "$exa_normalized" "$tavily_normalized" "$max_results")
    
    # Calculate elapsed time
    local end_time
    end_time=$(date +%s%N 2>/dev/null || echo "$(date +%s)000000000")
    local elapsed_ms=$(( (end_time - start_time) / 1000000 ))
    
    # Count results
    local total_results=0
    local unique_results
    unique_results=$(echo "$merged" | $JQ_CMD 'length')

    if [[ -n "$exa_result" ]]; then
        total_results=$((total_results + $(echo "$exa_result" | $JQ_CMD '.results | length')))
    fi
    if [[ -n "$tavily_result" ]]; then
        total_results=$((total_results + $(echo "$tavily_result" | $JQ_CMD '.results | length')))
    fi

    # Determine which providers succeeded
    local providers="[]"
    if [[ -n "$exa_result" ]]; then
        providers=$(echo "$providers" | $JQ_CMD '. + ["exa"]')
    fi
    if [[ -n "$tavily_result" ]]; then
        providers=$(echo "$providers" | $JQ_CMD '. + ["tavily"]')
    fi

    # Build response
    local response
    response=$($JQ_CMD -n \
        --arg query "$query" \
        --argjson results "$merged" \
        --argjson total "$total_results" \
        --argjson unique "$unique_results" \
        --argjson elapsed "$elapsed_ms" \
        --argjson providers "$providers" \
        '{
            success: true,
            query: $query,
            results: $results,
            meta: {
                total: $total,
                unique: $unique,
                cached: false,
                elapsed_ms: $elapsed,
                providers: $providers
            }
        }')
    
    # Cache the result
    set_cached_result "$query" "$max_results" "$response"
    
    # Output
    echo "$response"
}

# Run main
main "$@"
