#!/bin/bash
# Ralph Wiggum Loop for Mahilo Registry Development
# Runs Claude Code repeatedly until COMPLETE is signaled
#
# Usage: ./ralph.sh [max_iterations]
# Default: 50 iterations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROGRESS_FILE="$PROJECT_DIR/progress.txt"
TASKS_FILE="$PROJECT_DIR/docs/tasks-registry.md"
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
MAX_ITERATIONS="${1:-50}"

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
    echo "# Mahilo Registry Development Progress" > "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"
    echo "## Session Log" >> "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"
fi

echo "========================================"
echo " Mahilo Registry - Ralph Wiggum Loop"
echo "========================================"
echo ""
echo "Project Dir: $PROJECT_DIR"
echo "Progress File: $PROGRESS_FILE"
echo "Max Iterations: $MAX_ITERATIONS"
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
    echo ""
    echo "==============================================================="
    echo " Iteration $i of $MAX_ITERATIONS"
    echo " $(date)"
    echo "==============================================================="
    echo ""

    # Append iteration marker to progress file
    echo "" >> "$PROGRESS_FILE"
    echo "### Iteration $i - $(date)" >> "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"

    # Run Claude Code with the instructions from CLAUDE.md
    # Using --dangerously-skip-permissions for autonomous operation
    # Using --print to capture output
    OUTPUT=$(claude --dangerously-skip-permissions --print < "$CLAUDE_MD" 2>&1 | tee /dev/stderr) || true

    # Check for completion signal
    if echo "$OUTPUT" | grep -q "COMPLETE"; then
        echo ""
        echo "========================================"
        echo " COMPLETE signal detected!"
        echo " Finished at iteration $i of $MAX_ITERATIONS"
        echo "========================================"
        echo "" >> "$PROGRESS_FILE"
        echo "## COMPLETED" >> "$PROGRESS_FILE"
        echo "Finished at: $(date)" >> "$PROGRESS_FILE"
        exit 0
    fi

    echo ""
    echo "Iteration $i complete. Continuing in 3 seconds..."
    sleep 3
done

echo ""
echo "========================================"
echo " Reached max iterations ($MAX_ITERATIONS)"
echo " Check progress.txt for status"
echo "========================================"
exit 1
