# coding: utf-8

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

from __future__ import print_function, unicode_literals

from six import string_types
import sys

from ..diff_format import SequenceDiffBuilder, MappingDiffBuilder, DiffOp, offset_op
from ..diff_format import as_dict_based_diff
from ..patching import patch
from .chunks import make_merge_chunks


# FIXME: Move to utils
def as_text_lines(text):
    if isinstance(text, string_types):
        text = text.splitlines(True)
    if isinstance(text, tuple):
        text = list(text)
    assert isinstance(text, list)
    assert all(isinstance(t, string_types) for t in text)
    return text


# FIXME: Move to utils
def format_text_merge_display(base, local, remote,
                              base_title="base", local_title="local", remote_title="remote"):
    local = as_text_lines(local)
    base = as_text_lines(base)
    remote = as_text_lines(remote)

    n = 7  # git uses 7
    sep0 = "%s %s\n" % ("<"*n, local_title)
    sep1 = "%s %s\n" % ("="*n, base_title)
    sep2 = "%s %s\n" % ("="*n, remote_title)
    sep3 = "%s\n" % (">"*n,)

    return "".join([sep0] + local + [sep1] + base + [sep2] + remote + [sep3])


# Sentinel object
Deleted = object()


def patch_item(value, diffentry):
    if diffentry is None:
        return value
    op = diffentry.op
    if op == DiffOp.REPLACE:
        return diffentry.value
    elif op == DiffOp.PATCH:
        return patch(value, diffentry.diff)
    elif op == DiffOp.REMOVE:
        return Deleted
    else:
        raise ValueError("Invalid item patch op {}".format(op))


def make_join_value(value, le, re):
    # Joining e.g. an outputs list means concatenating all items
    lvalue = patch_item(value, le)
    rvalue = patch_item(value, re)

    if lvalue is Deleted:
        lvalue = []
    if rvalue is Deleted:
        rvalue = []

    # New list
    newvalue = value + lvalue + rvalue

    return newvalue


def make_inline_outputs_value(value, le, re,
                              local_title="local", remote_title="remote"):
    # FIXME: Use this for inline outputs diff?
    # Joining e.g. an outputs list means concatenating all items
    lvalue = patch_item(value, le)
    rvalue = patch_item(value, re)

    if lvalue is Deleted:
        lvalue = []
    if rvalue is Deleted:
        rvalue = []

    # Note: This is very notebook specific while the rest of this file is more generic
    newvalue = (
        [{"output_type": "stream", "name": "stderr", "text": ["<"*7 + local_title]}]
        + lvalue
        + [{"output_type": "stream", "name": "stderr", "text": ["="*7]}]
        + rvalue
        + [{"output_type": "stream", "name": "stderr", "text": ["<"*7 + remote_title]}]
        )

    return newvalue


def make_inline_source_value(base, le, re):  # FIXME: Test this!
    if le.op == DiffOp.REPLACE:
        local = le.value
    elif le.op == DiffOp.PATCH:
        local = patch(base, le.diff)
    elif le.op == DiffOp.REMOVE:
        local = []  # ""
    else:
        raise ValueError("Invalid item patch op {}".format(le.op))

    if re.op == DiffOp.REPLACE:
        remote = re.value
    elif re.op == DiffOp.PATCH:
        remote = patch(base, re.diff)
    elif re.op == DiffOp.REMOVE:
        remote = []  # ""
    else:
        raise ValueError("Invalid item patch op {}".format(re.op))

    # FIXME: use format_text_merge_display for each conflicting chunk?
    e = format_text_merge_display(base, local, remote)
    return e


def make_cleared_value(value):
    "Make a new 'cleared' value of the right type."
    if isinstance(value, list):
        # Clearing e.g. an outputs list means setting it to an empty list
        return []
    elif isinstance(value, dict):
        # Clearing e.g. a metadata dict means setting it to an empty dict
        return {}
    elif isinstance(value, string_types):
        # Clearing e.g. a source string means setting it to an empty string
        return ""
    else:
        # Clearing anything else (atomic values) means setting it to None
        return None


def add_conflicts_record(value, le, re):
    """Add an item 'nbdime-conflicts' to a metadata dict.

    Simply storing metadata conflicts for mergetool inspection.
    """
    assert isinstance(value, dict)
    c = {}
    if le is not None:
        c["local"] = le
    if re is not None:
        c["remote"] = re
    newvalue = dict(value)
    newvalue["nbdime-conflicts"] = c
    return newvalue


def resolve_dict_item_conflict(value, le, re, strategy, path):
    assert le is None or re is None or le.key == re.key

    print('autoresolving conflict at %s with %s' % (path, strategy), file=sys.stderr)

    # Default values for variables set in strategy 'switch' below
    noconflict = False  # Sometimes we get here without there being an actual conflict at this level
    newvalue = None     # Return value, set in all cases below

    # The rest here remove the conflicts and provide a new value
    # ... cases ignoring changes
    if strategy == "clear":
        newvalue = make_cleared_value(value)
    elif strategy == "use-base":
        newvalue = value
    # ... cases ignoring changes from one side
    elif strategy == "use-local":
        newvalue = patch_item(value, le)
    elif strategy == "use-remote":
        newvalue = patch_item(value, re)
    # ... cutoffs before cases using changes from both sides
    elif le is None:
        # Only one sided change, use that
        noconflict = True
        newvalue = patch_item(value, re)
    elif re is None:
        # Only one sided change, use that
        noconflict = True
        newvalue = patch_item(value, le)
    elif le == re:
        # Both changes are equal, just apply
        noconflict = True
        newvalue = patch_item(value, le)
    # ... cases using changes from both sides
    elif strategy == "inline-source":
        newvalue = make_inline_source_value(value, le, re)
    elif strategy == "inline-outputs":
        newvalue = make_inline_outputs_value(value, le, re)
    elif strategy == "join":
        newvalue = make_join_value(value, le, re)
    elif strategy == "record-conflict":
        newvalue = add_conflicts_record(value, le, re)
    # ...
    elif strategy == "mergetool":
        # Leave this type of conflict for external tool to resolve
        newvalue = value
        return (newvalue, le, re)
    elif strategy == "fail":
        # Expecting never to get this kind of conflict, raise error
        raise RuntimeError("Not expecting a conflict at path {}.".format(path))
    else:
        raise RuntimeError("Invalid strategy {}.".format(strategy))

    if noconflict:
        print('no actual conflict at %s' % (path,), file=sys.stderr)

    return (newvalue, None, None)


def resolve_list_item_conflicts(merged, lcd, rcd, strategy, path):
    "Resolve conflicts for all items in list."

    # Leave this type of conflict for other tool to resolve
    if strategy == "mergetool":
        return (merged, lcd, rcd)

    # The rest here remove the conflicts and provide a new value
    if strategy == "use-base":
        resolved = merged
    elif strategy == "use-local":
        resolved = patch(merged, lcd)
    elif strategy == "use-remote":
        resolved = patch(merged, rcd)
    elif strategy == "fail":
        raise RuntimeError("Not expecting a conflict at path {}.".format(path))
    else:
        # I think "clear", "inline", "join" don't make sense for list items, but are rather applied to the list itself instead?
        raise RuntimeError("Not expecting strategy {} for list items at path {}.".format(strategy, path))

    return (resolved, [], [])


def autoresolve_lists(merged, lcd, rcd, strategies, path):
    key = "*"
    subpath = "/".join((path, key))
    strategy = strategies.get(subpath)

    # Cutting off handling of strategies of subitems if there's a strategy for these list items
    if strategy:
        return resolve_list_item_conflicts(merged, lcd, rcd, strategy, path)

    # Data structures for storing conflicts
    resolved = []
    newlcd = SequenceDiffBuilder()
    newrcd = SequenceDiffBuilder()

    # Offset of indices between merged and resolved
    merged_offset = 0

    # Split up and combine diffs into chunks [(begin, end, localdiffs, remotediffs)]
    chunks = make_merge_chunks(merged, lcd, rcd)

    # Loop over chunks of base[j:k], grouping insertion at j into
    # the chunk starting with j
    for (j, k, d0, d1) in chunks:
        lpatches = [e for e in d0 if e.op == DiffOp.PATCH]
        rpatches = [e for e in d1 if e.op == DiffOp.PATCH]
        if not (d0 or d1):
            # Unmodified chunk
            resolved.extend(merged[j:k])

        elif lpatches and rpatches:
            # Recurse if we have diffs available for both subdocuments
            assert len(lpatches) == 1
            assert len(rpatches) == 1
            linserts = [e for e in d0 if e.op == DiffOp.ADDRANGE]
            rinserts = [e for e in d1 if e.op == DiffOp.ADDRANGE]
            assert len(lpatches) + len(linserts) == len(d0)
            assert len(rpatches) + len(rinserts) == len(d1)
            assert k == j + 1
            assert all(e.key == j for e in linserts + rinserts)

            le, = lpatches
            re, = rpatches
            newvalue, ldi, rdi = autoresolve(merged[j], le.diff, re.diff, strategies, subpath)

            # NB! Possibly contentious handling of inserts here:
            if not (ldi or rdi):
                # Patch conflicts have been resolved, allow inserts from both sides
                for e in linserts + rinserts:
                    resolved.extend(e.valuelist)
                    merged_offset += len(e.valuelist) # FIXME: Correct?
            else:
                # Keep inserts as conflicts
                for e in linserts:
                    newlcd.append(e)
                for e in rinserts:
                    newrcd.append(e)

            # Now add patch entries with result of autoresolve recursion
            if newvalue is Deleted:
                merged_offset -= 1 # FIXME: Correct?
                assert not ldi and not rdi
            else:
                resolved.append(newvalue)
                if ldi:
                    newlcd.patch(j, ldi)
                if rdi:
                    newrcd.patch(j, rdi)
        else:
            # FIXME: What has happened here? This is hard to follow, enumerate cases!
            # - at least one side is modified
            # - only 0 or 1 has a patch
            # - FIXME: Handle cell source if one cell is patched and one cell is deleted!

            # Just keep input and conflicts but offset conflicts
            resolved.extend(merged[j:k])
            for e in d0:
                newlcd.append(offset_op(e, merged_offset))
            for e in d1:
                newrcd.append(offset_op(e, merged_offset))

    return resolved, newlcd.validated(), newrcd.validated()


def autoresolve_dicts(merged, lcd, rcd, strategies, path):

    # lcd = local conflict diffs
    # rcd = remote conflict diffs

    # Converting to dict-based diff format for dicts for convenience
    # This step will be unnecessary if we change the diff format to work this way always
    lcd = as_dict_based_diff(lcd)
    rcd = as_dict_based_diff(rcd)

    # This previous assumption is not valid:
    # We can't have a one-sided conflict so keys must match
    #assert set(lcd) == set(rcd)

    # Get diff keys
    bldkeys = set(lcd.keys())
    brdkeys = set(rcd.keys())
    dkeys = bldkeys | brdkeys
    #ckeys = bldkeys & brdkeys

    # (1) Use base values for all keys with no change
    resolved = {key: merged[key] for key in set(merged.keys()) - dkeys}

    # Builders for remaining conflicts
    newlcd = MappingDiffBuilder()
    newrcd = MappingDiffBuilder()

    for key in sorted(dkeys):
        # Query out how to handle conflicts in this part of the document
        subpath = "/".join((path, key))
        strategy = strategies.get(subpath)

        # Get value and conflicts
        value = merged[key]
        le = lcd.get(key)
        re = rcd.get(key)
        assert le is None or le.key == key
        assert re is None or re.key == key

        if strategy is not None:
            # Autoresolve conflicts for this key
            newvalue, le, re = resolve_dict_item_conflict(value, le, re, strategy, subpath)
            if le is not None:
                newlcd.append(le)
            if re is not None:
                newrcd.append(re)
        elif le is not None and re is not None and le.op == DiffOp.PATCH and re.op == DiffOp.PATCH:
            # Recurse if we have no strategy for this key but diffs available for the subdocument
            newvalue, ldi, rdi = autoresolve(value, le.diff, re.diff, strategies, subpath)
            if ldi:
                newlcd.patch(key, ldi)
            if rdi:
                newrcd.patch(key, rdi)
        else:
            # Alternatives if we don't have PATCH, are:
            #  - ADD: only happens if inserted values are different, could possibly autoresolve some cases but nothing important
            #  - REPLACE: technically possible, if so we can can convert it to PATCH, but does it happen?
            #  - REMOVE: more likely, but resolving subdocument diff will still leave us with a full conflict on parent here
            # No resolution, keep conflicts le, re
            newvalue = value
            if le is not None:
                newlcd.append(le)
            if re is not None:
                newrcd.append(re)

        # Add new value unless deleted
        if newvalue is Deleted:
            assert key not in resolved
        else:
            resolved[key] = newvalue

    return resolved, newlcd.validated(), newrcd.validated()


def autoresolve(merged, local_diff, remote_diff, strategies, path):
    """
    Returns: resolution_diff, unresolved_local_diff, unresolved_remote_diff
    """
    if isinstance(merged, dict):
        return autoresolve_dicts(merged, local_diff, remote_diff, strategies, path)
    elif isinstance(merged, list):
        return autoresolve_lists(merged, local_diff, remote_diff, strategies, path)
    else:
        raise RuntimeError("Invalid merged type {} at path {}".format(type(merged).__name__, path))
