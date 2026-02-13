#!/usr/bin/env bash
set -euo pipefail

# Resolves provider-specific env vars into Claude CLI-compatible ANTHROPIC_* vars.
# Usage:
#   eval "$(/app/scripts/resolve-llm-provider.sh)"

provider="${LLM_PROVIDER:-anthropic}"
provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"

require_non_empty() {
    local name="$1"
    local value="$2"
    if [[ -z "$value" ]]; then
        echo "[resolve-llm-provider] Missing required env: $name" >&2
        exit 1
    fi
}

mask_value() {
    local value="$1"
    if [[ -z "$value" ]]; then
        printf 'unset'
        return
    fi
    if [[ ${#value} -le 8 ]]; then
        printf '***'
        return
    fi
    printf '%s***%s' "${value:0:4}" "${value: -2}"
}

resolve_anthropic() {
    # Backward-compatible fallback to legacy ANTHROPIC_* vars.
    local base_url="${LLM_ANTHROPIC_BASE_URL:-${ANTHROPIC_BASE_URL:-}}"
    local api_key="${LLM_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"
    local auth_token="${LLM_ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_AUTH_TOKEN:-}}"

    if [[ -z "$api_key" && -z "$auth_token" ]]; then
        echo "[resolve-llm-provider] Missing credentials: set LLM_ANTHROPIC_API_KEY or LLM_ANTHROPIC_AUTH_TOKEN (legacy ANTHROPIC_* also supported)." >&2
        exit 1
    fi

    {
        printf 'export LLM_PROVIDER=%q\n' "$provider"
        printf 'export ANTHROPIC_BASE_URL=%q\n' "$base_url"
        printf 'export ANTHROPIC_API_KEY=%q\n' "$api_key"
        printf 'export ANTHROPIC_AUTH_TOKEN=%q\n' "$auth_token"
    }

    echo "[resolve-llm-provider] provider=anthropic base_url=${base_url:-default} api_key=$(mask_value "$api_key") auth_token=$(mask_value "$auth_token")" >&2
}

resolve_openrouter() {
    local base_url="${LLM_OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
    local api_key="${LLM_OPENROUTER_API_KEY:-}"
    require_non_empty "LLM_OPENROUTER_API_KEY" "$api_key"

    {
        printf 'export LLM_PROVIDER=%q\n' "$provider"
        printf 'export ANTHROPIC_BASE_URL=%q\n' "$base_url"
        printf 'export ANTHROPIC_API_KEY=%q\n' "$api_key"
        printf "export ANTHROPIC_AUTH_TOKEN=''\n"
    }

    echo "[resolve-llm-provider] provider=openrouter base_url=${base_url} api_key=$(mask_value "$api_key")" >&2
}

resolve_proxy() {
    local base_url="${LLM_PROXY_BASE_URL:-}"
    local api_key="${LLM_PROXY_API_KEY:-}"
    local auth_token="${LLM_PROXY_AUTH_TOKEN:-}"

    require_non_empty "LLM_PROXY_BASE_URL" "$base_url"
    if [[ -z "$api_key" && -z "$auth_token" ]]; then
        echo "[resolve-llm-provider] Missing credentials: set LLM_PROXY_API_KEY or LLM_PROXY_AUTH_TOKEN" >&2
        exit 1
    fi

    {
        printf 'export LLM_PROVIDER=%q\n' "$provider"
        printf 'export ANTHROPIC_BASE_URL=%q\n' "$base_url"
        printf 'export ANTHROPIC_API_KEY=%q\n' "$api_key"
        printf 'export ANTHROPIC_AUTH_TOKEN=%q\n' "$auth_token"
    }

    echo "[resolve-llm-provider] provider=proxy base_url=${base_url} api_key=$(mask_value "$api_key") auth_token=$(mask_value "$auth_token")" >&2
}

resolve_zai() {
    local base_url="${LLM_ZAI_BASE_URL:-}"
    local api_key="${LLM_ZAI_API_KEY:-}"
    local auth_token="${LLM_ZAI_AUTH_TOKEN:-}"

    require_non_empty "LLM_ZAI_BASE_URL" "$base_url"
    if [[ -z "$api_key" && -z "$auth_token" ]]; then
        echo "[resolve-llm-provider] Missing credentials: set LLM_ZAI_API_KEY or LLM_ZAI_AUTH_TOKEN" >&2
        exit 1
    fi

    {
        printf 'export LLM_PROVIDER=%q\n' "$provider"
        printf 'export ANTHROPIC_BASE_URL=%q\n' "$base_url"
        printf 'export ANTHROPIC_API_KEY=%q\n' "$api_key"
        printf 'export ANTHROPIC_AUTH_TOKEN=%q\n' "$auth_token"
    }

    echo "[resolve-llm-provider] provider=zai base_url=${base_url} api_key=$(mask_value "$api_key") auth_token=$(mask_value "$auth_token")" >&2
}

resolve_minimax() {
    local base_url="${LLM_MINIMAX_BASE_URL:-}"
    local api_key="${LLM_MINIMAX_API_KEY:-}"
    local auth_token="${LLM_MINIMAX_AUTH_TOKEN:-}"

    require_non_empty "LLM_MINIMAX_BASE_URL" "$base_url"
    if [[ -z "$api_key" && -z "$auth_token" ]]; then
        echo "[resolve-llm-provider] Missing credentials: set LLM_MINIMAX_API_KEY or LLM_MINIMAX_AUTH_TOKEN" >&2
        exit 1
    fi

    {
        printf 'export LLM_PROVIDER=%q\n' "$provider"
        printf 'export ANTHROPIC_BASE_URL=%q\n' "$base_url"
        printf 'export ANTHROPIC_API_KEY=%q\n' "$api_key"
        printf 'export ANTHROPIC_AUTH_TOKEN=%q\n' "$auth_token"
    }

    echo "[resolve-llm-provider] provider=minimax base_url=${base_url} api_key=$(mask_value "$api_key") auth_token=$(mask_value "$auth_token")" >&2
}

case "$provider" in
    anthropic)
        resolve_anthropic
        ;;
    openrouter)
        resolve_openrouter
        ;;
    proxy)
        resolve_proxy
        ;;
    zai)
        resolve_zai
        ;;
    minimax)
        resolve_minimax
        ;;
    *)
        echo "[resolve-llm-provider] Unsupported LLM_PROVIDER: $provider (supported: anthropic, openrouter, proxy, zai, minimax)" >&2
        exit 1
        ;;
esac
