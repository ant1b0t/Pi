#!/usr/bin/env python3
"""
Test subagents in Pi
Runs pi with base-agents extension and tests agent_spawn
"""

import subprocess
import sys
import json

def run_pi_with_agents():
    """Run Pi with base-agents extension"""
    
    # Test 1: Simple agent_list command (should return empty list)
    cmd = [
        "pi", "--print", "-p",
        "--tools", "read,bash,agent_spawn,agent_join,agent_list",
        "-e", "extensions/base/base-agents.ts",
        "Call agent_list to check if subagents are working"
    ]
    
    print("=" * 60)
    print("Test 1: Check agent_list")
    print("=" * 60)
    print(f"Command: {' '.join(cmd[:8])}...")
    print()
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60
        )
        print("STDOUT:")
        print(result.stdout[:2000] if len(result.stdout) > 2000 else result.stdout)
        if result.stderr:
            print("\nSTDERR:")
            print(result.stderr[:1000] if len(result.stderr) > 1000 else result.stderr)
        print(f"\nReturn code: {result.returncode}")
    except subprocess.TimeoutExpired:
        print("TIMEOUT! Command took too long")
    except Exception as e:
        print(f"Error: {e}")

def test_agent_spawn():
    """Test creating a subagent"""
    
    cmd = [
        "pi", "--print", "-p",
        "--tools", "read,bash,agent_spawn,agent_join,agent_list",
        "-e", "extensions/base/base-agents.ts",
        """Create a subagent using agent_spawn:
        - name: "math-helper"
        - task: "Calculate factorial of 5 and explain how factorials work"
        - tier: "low"
        
        Then call agent_join to get the result.
        """
    ]
    
    print("\n" + "=" * 60)
    print("Test 2: Creating subagent (agent_spawn)")
    print("=" * 60)
    print(f"Command: pi --print -p ...")
    print()
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120
        )
        print("STDOUT:")
        print(result.stdout[:3000] if len(result.stdout) > 3000 else result.stdout)
        if result.stderr:
            print("\nSTDERR:")
            print(result.stderr[:1000] if len(result.stderr) > 1000 else result.stderr)
        print(f"\nReturn code: {result.returncode}")
    except subprocess.TimeoutExpired:
        print("TIMEOUT! Command took too long (this is normal for first run)")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    print("Testing subagents in Pi")
    print()
    
    run_pi_with_agents()
    # test_agent_spawn()  # Uncomment for full test
    
    print("\n" + "=" * 60)
    print("For full test with agent_spawn uncomment")
    print("test_agent_spawn() call at the end of script")
    print("=" * 60)
