import os
import sys

# Make the sibling modules (federation_config, peer_client, ...) importable
# when pytest is run from anywhere.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
