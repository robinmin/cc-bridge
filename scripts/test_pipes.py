import asyncio
import os
import sys
from pathlib import Path

# Add current directory to path
sys.path.append(os.getcwd())

from cc_bridge.core.named_pipe import NamedPipeChannel

async def test_communication():
    pipe_dir = Path("/tmp/cc-bridge/cc-bridge/pipes")
    instance_name = "claude"
    
    print(f"Opening pipes in {pipe_dir} for instance {instance_name}...")
    
    # We'll use NamedPipeChannel but manually manage lifecycle for this test
    channel = NamedPipeChannel(instance_name, pipe_dir)
    channel.create_pipes()
    
    try:
        print("Pipes created. Waiting for agent to connect...")
        print("Sending '/status' command...")
        
        # We need to run concurrently: one task to write, one to read
        # Because the agent won't respond until it sees the command,
        # and it won't see the command until it finishes its handshake.
        
        async def run_test():
            # Send command (wrapped in a task so it can wait for reader)
            write_task = asyncio.create_task(channel.write_command("/status", timeout=30.0))
            
            print("Reading response (waiting for output pipe)...")
            async for line in channel.read_response(timeout=30.0):
                print(f"  > {line}")
                if "status" in line.lower() or "claude" in line.lower():
                    print("Received valid response!")
                    break
            
            await write_task
            print("Test completed successfully.")

        await run_test()
        
    except Exception as e:
        print(f"Error: {e}")
    finally:
        print("Cleaning up pipes...")
        channel.close()

if __name__ == "__main__":
    asyncio.run(test_communication())
