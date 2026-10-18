# Started by Task Scheduler on the owner's PC (pythonw: no console window). See README.md.
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, ".deps")]
from slotmon import worker
sys.exit(worker.main())
