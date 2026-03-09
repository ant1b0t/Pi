#!/usr/bin/env bash
#
# Test runner for base-agents
# Usage: ./scripts/test-base-agents.sh [unit|integration|all]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${BLUE}"
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║           Base Agents Test Suite                                 ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_section() {
    echo -e "${YELLOW}\n▶ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

run_unit_tests() {
    print_section "Running Unit Tests"
    
    if bun test specs/base-agents.unit.test.ts --timeout 30000; then
        print_success "Unit tests passed"
        return 0
    else
        print_error "Unit tests failed"
        return 1
    fi
}

run_integration_tests() {
    print_section "Running Integration Tests"
    
    if bun test specs/base-agents.integration.test.ts --timeout 60000; then
        print_success "Integration tests passed"
        return 0
    else
        print_error "Integration tests failed"
        return 1
    fi
}

run_manual_checklist() {
    print_section "Manual Testing Checklist"
    
    cat << 'EOF'
Run the following commands manually in Pi:

1. Start base-agents:
   pi -e extensions/base/base-agents.ts

2. Test agent_spawn:
   agent_spawn tags="Bash" task="echo hello world" name="test-agent"

3. Test agent_list:
   agent_list

4. Test agent_join:
   agent_join id=1 timeout=30

5. Test agent_continue:
   agent_continue id=1 prompt="echo continued"

6. Test agent_kill:
   agent_kill id=1

7. Test commands:
   /agents
   /akill 1
   /aclear

8. Verify session files:
   ls -la .pi/agent-sessions/

EOF
}

generate_report() {
    print_section "Generating Test Report"
    
    REPORT_FILE="test-report-$(date +%Y%m%d-%H%M%S).md"
    
    cat > "$REPORT_FILE" << EOF
# Base Agents Test Report

**Date:** $(date)
**Branch:** $(git branch --show-current 2>/dev/null || echo "N/A")
**Commit:** $(git rev-parse --short HEAD 2>/dev/null || echo "N/A")

## Unit Tests
\`\`\`
$(bun test specs/base-agents.unit.test.ts 2>&1 || echo "Tests failed")
\`\`\`

## Integration Tests
\`\`\`
$(bun test specs/base-agents.integration.test.ts 2>&1 || echo "Tests failed")
\`\`\`

## Manual Checklist

- [ ] agent_spawn creates agent with valid parameters
- [ ] agent_list shows all agents
- [ ] agent_join waits for completion
- [ ] agent_continue resumes conversation
- [ ] agent_kill terminates agent
- [ ] /agents shows widget
- [ ] /akill kills by ID
- [ ] /aclear clears finished agents
- [ ] Session files created in .pi/agent-sessions/

## Notes

$(cat << 'NOTES'
(Add any manual observations here)
NOTES
)
EOF

    print_success "Report saved to $REPORT_FILE"
}

main() {
    print_header
    
    case "${1:-all}" in
        unit)
            run_unit_tests
            ;;
        integration)
            run_integration_tests
            ;;
        manual)
            run_manual_checklist
            ;;
        report)
            generate_report
            ;;
        all)
            run_unit_tests
            run_integration_tests
            print_section "Test Summary"
            print_success "All automated tests passed!"
            echo ""
            run_manual_checklist
            ;;
        *)
            echo "Usage: $0 [unit|integration|manual|report|all]"
            echo ""
            echo "Commands:"
            echo "  unit         - Run unit tests only"
            echo "  integration  - Run integration tests only"
            echo "  manual       - Show manual testing checklist"
            echo "  report       - Generate test report"
            echo "  all          - Run everything (default)"
            exit 1
            ;;
    esac
}

main "$@"
