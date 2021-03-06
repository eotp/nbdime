#!/usr/bin/env python
# -*- coding:utf-8 -*-

from __future__ import print_function
from __future__ import unicode_literals

from argparse import ArgumentParser
import os.path
import webbrowser
import logging
import threading
from tornado.httputil import url_concat

from .nbdimeserver import main as run_server


_logger = logging.getLogger(__name__)


# TODO: Server starts on random port (in optionally specified port range)
# TODO: Server is passed a (mandatory?) single-use access token, which is
#       used to authenticate the browser session.

def build_arg_parser():
    """
    Creates an argument parser for the diff tool, that also lets the 
    user specify a port and displays a help message.
    """
    description = 'Difftool for Nbdime.'
    parser = ArgumentParser(description=description)
    parser.add_argument('-p', '--port', default=8899,
                        help="Specify the port you want the server "
                             "to run on. Default is 8899.")
    parser.add_argument("local", help="The local file of the diff comparison.")
    parser.add_argument("remote", help="The remote file of the diff comparison.")
    return parser


def browse(port, base, remote):
    try:
        browser = webbrowser.get(None)
    except webbrowser.Error as e:
        _logger.warning('No web browser found: %s.', e)
        browser = None
    
    if browser:
        b = lambda: browser.open(
            url_concat("http://localhost:%s/diff" % port,
                       dict(base=base, remote=remote)),
            new=2)
        threading.Thread(target=b).start()


def main():
    arguments = build_arg_parser().parse_args()
    port = arguments.port
    cwd = os.path.abspath(os.path.curdir)
    local = arguments.local
    remote = arguments.remote
    browse(port, local, remote)
    run_server(port=port, cwd=cwd)

if __name__ == "__main__":
    main()
